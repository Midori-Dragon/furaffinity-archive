/**
 * fetch-latest-banners.cjs
 *
 * Reads the newest banner(s) from the FurAffinity Banner Museum, downloads any that are
 * missing from assets/fa_archive/banners/ and writes the archive's XMP tags into them.
 *
 * The museum page exposes everything needed as data-* attributes on each banner <img>:
 *   data-filename, data-original-ext, data-year, data-month, data-artist-lowers
 *
 * Tags written (mirroring what generate-archive-metadata.cjs reads back):
 *   XMP-dc:Title                   – "<Month> <Year> Banner"
 *   XMP-dc:Creator                 – artist profile URL
 *   XMP-photoshop:AuthorsPosition  – artist username
 *   XMP-dc:Source                  – direct CDN URL of the full-size image
 *   XMP-xmp:CreateDate             – first of the banner's month
 *
 * Usage: node build-scripts/fetch-latest-banners.cjs [--limit <n>] [--dry-run]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { exiftool } = require('exiftool-vendored');

const BANNER_MUSEUM_URL = 'https://www.furaffinity.net/route/banner_museum';
const BANNERS_DIR = path.resolve('./assets/fa_archive/banners');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) furaffinity-archive/1.0';

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

// ANSI colors (same style as other build scripts)
const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    blue: '\x1b[34m',
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Parse command line arguments.
 * @param {string[]} argv
 * @returns {{ limit: number, dryRun: boolean }}
 */
function parseArgs(argv) {
    let limit = 1;
    let dryRun = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') {
            dryRun = true;
        } else if (arg === '--limit') {
            limit = Number(argv[++i]);
        } else if (arg.startsWith('--limit=')) {
            limit = Number(arg.slice('--limit='.length));
        }
    }

    if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`--limit must be a positive integer, got "${limit}"`);
    }

    return { limit, dryRun };
}

// ---------------------------------------------------------------------------
// Banner museum scraping
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and return its body as a Buffer.
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function fetchBuffer(url) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    return Buffer.from(await res.arrayBuffer());
}

/**
 * Fetch the banner museum page and return the <img> elements of the newest banners.
 * @param {number} limit maximum number of banners to return
 * @returns {Promise<{ $: cheerio.CheerioAPI, images: any[] }>}
 */
async function fetchBannerImages(limit) {
    const html = (await fetchBuffer(BANNER_MUSEUM_URL)).toString('utf8');
    const $ = cheerio.load(html);

    const columnPage = $('#columnpage');
    if (columnPage.length === 0) throw new Error('Banner museum: #columnpage not found');

    const sectionBody = columnPage.find('div.section-body').first();
    if (sectionBody.length === 0) throw new Error('Banner museum: div.section-body not found');

    const artWall = sectionBody.find('section[class*="artwall" i]').first();
    if (artWall.length === 0) throw new Error('Banner museum: artwall section not found');

    const images = artWall.children('div')
        .slice(0, limit)
        .map((_, div) => $(div).find('img').first())
        .get()
        .filter(img => img.length > 0);

    if (images.length === 0) throw new Error('Banner museum: artwall section contains no banners');

    return { $, images };
}

/**
 * Replace the last occurrence of a substring.
 * @param {string} str
 * @param {string} search
 * @param {string} replacement
 * @returns {string}
 */
function replaceLast(str, search, replacement) {
    const index = str.lastIndexOf(search);
    if (index === -1) return str;
    return str.slice(0, index) + replacement + str.slice(index + search.length);
}

/**
 * Build the archive metadata for a banner <img>.
 * @param {any} img cheerio-wrapped <img> element
 * @param {boolean} doReplaceThumbnail resolve the full-size URL instead of the thumbnail
 * @returns {{ imageUrl: string, fullFileName: string, tags: Record<string, string> }}
 */
function getBannerMetadata(img, doReplaceThumbnail) {
    const src = img.attr('src') || '';
    let imageUrl = src.startsWith('//') ? `https:${src}` : src;

    if (doReplaceThumbnail) {
        imageUrl = replaceLast(imageUrl, '-thumbnail.', '.');
    }

    const baseFilename = img.attr('data-filename');
    if (!baseFilename) throw new Error(`Banner without data-filename (src: ${src || 'none'})`);

    const fileType = img.attr('data-original-ext') || 'jpg';
    const fullFileName = `${baseFilename}.${fileType}`;

    const year = img.attr('data-year');
    const monthNumber = Number(img.attr('data-month'));
    const monthName = MONTH_NAMES[monthNumber - 1] || 'Unknown';

    const artistLower = img.attr('data-artist-lowers') || '';

    const tags = {
        'XMP-dc:Title': `${monthName} ${year} Banner`,
        'XMP-dc:Creator': artistLower ? `https://www.furaffinity.net/user/${artistLower}/` : '',
        'XMP-photoshop:AuthorsPosition': artistLower,
        'XMP-dc:Source': imageUrl,
        'XMP-xmp:CreateDate': `${year}-${String(monthNumber).padStart(2, '0')}-01`,
    };

    return { imageUrl, fullFileName, tags };
}

// ---------------------------------------------------------------------------
// Archiving
// ---------------------------------------------------------------------------

/**
 * Build a lookup of the banner filenames already archived, keyed lowercase.
 * @returns {Set<string>}
 */
function readExistingBanners() {
    if (!fs.existsSync(BANNERS_DIR)) throw new Error(`Banner directory not found: ${BANNERS_DIR}`);
    return new Set(fs.readdirSync(BANNERS_DIR).map(f => f.toLowerCase()));
}

/**
 * Download a banner and write it, tagged, into the archive.
 * @param {any} img cheerio-wrapped <img> element
 * @returns {Promise<string>} the archived filename
 */
async function archiveBanner(img) {
    const full = getBannerMetadata(img, true);
    const fallback = getBannerMetadata(img, false);

    let buffer;
    let used = full;
    try {
        buffer = await fetchBuffer(full.imageUrl);
    } catch (err) {
        console.warn(`  ${c.yellow}– full-size failed (${err.message}), trying thumbnail${c.reset}`);
        buffer = await fetchBuffer(fallback.imageUrl);
        used = fallback;
    }

    const destPath = path.join(BANNERS_DIR, used.fullFileName);
    fs.writeFileSync(destPath, buffer);

    try {
        await exiftool.write(destPath, used.tags, { writeArgs: ['-overwrite_original'] });
    } catch (err) {
        fs.rmSync(destPath, { force: true });
        throw err;
    }

    console.log(`  ${c.green}✓ ${used.fullFileName}${c.reset} (${buffer.length} bytes, tagged)`);
    return used.fullFileName;
}

// ---------------------------------------------------------------------------
// Workflow output
// ---------------------------------------------------------------------------

/**
 * Build a commit message in the style used by the archive's history
 * ("july 29 banner 2026", "2 new banners").
 * @param {string[]} files archived filenames
 * @param {any} firstImg cheerio-wrapped <img> of the first archived banner
 * @returns {string}
 */
function buildCommitMessage(files, firstImg) {
    if (files.length > 1) return `${files.length} new banners`;

    const year = firstImg.attr('data-year');
    const month = MONTH_NAMES[Number(firstImg.attr('data-month')) - 1];
    if (!year || !month) return `new banner ${files[0]}`;

    const dayMatch = path.parse(files[0]).name.match(/(?<!\d)\d{4}\d{2}(\d{2})(?!\d)/);
    const day = dayMatch ? ` ${Number(dayMatch[1])}` : '';

    return `${month.toLowerCase()}${day} banner ${year}`;
}

/**
 * Append key=value pairs to the GitHub Actions step output file, when running in Actions.
 * @param {Record<string, string|number>} outputs
 */
function writeStepOutputs(outputs) {
    const file = process.env.GITHUB_OUTPUT;
    if (!file) return;

    const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`);
    fs.appendFileSync(file, lines.join(''), 'utf8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const { limit, dryRun } = parseArgs(process.argv.slice(2));

    console.log(`${c.blue}[banners]${c.reset} checking the newest ${limit} banner(s)${dryRun ? ' (dry run)' : ''}`);

    const { images } = await fetchBannerImages(limit);
    const existing = readExistingBanners();

    const added = [];
    let firstAddedImg = null;

    for (const img of images) {
        const { fullFileName } = getBannerMetadata(img, true);

        if (existing.has(fullFileName.toLowerCase())) {
            console.log(`  ${c.yellow}– ${fullFileName} already archived${c.reset}`);
            continue;
        }

        if (dryRun) {
            console.log(`  ${c.cyan}→ ${fullFileName} would be added${c.reset}`);
        } else {
            await archiveBanner(img);
        }

        added.push(fullFileName);
        if (!firstAddedImg) firstAddedImg = img;
    }

    const commitMessage = added.length > 0 ? buildCommitMessage(added, firstAddedImg) : '';
    writeStepOutputs({
        added: added.length,
        files: added.join(','),
        commit_message: commitMessage,
    });

    if (added.length === 0) {
        console.log(`\n${c.green}✓ Archive is up to date${c.reset}`);
    } else {
        console.log(`\n${c.green}✓ ${added.length} banner(s) ${dryRun ? 'pending' : 'added'}${c.reset}: ${added.join(', ')}`);
    }
}

main()
    .catch(err => {
        console.error(`${c.red}✗ ${err.message}${c.reset}`);
        process.exit(1);
    })
    .finally(() => exiftool.end());
