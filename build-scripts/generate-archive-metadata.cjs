/**
 * generate-archive-metadata.cjs
 *
 * Scans assets/fa_archive/ for images, generates docs/resources/fa_archive/index.json,
 * and copies images to docs/resources/fa_archive/<category>/.
 *
 * Structure expected in assets/fa_archive/:
 *   <category>/               – reworked/processed images (metadata extracted if present)
 *   <category>/original/      – original archived images (metadata extracted)
 *
 * The JSON uses keys "<category>" and "<category>-originals".
 *
 * Supported formats: .jpg, .jpeg, .png, .webp, .gif, .svg
 *
 * Metadata is read from standard EXIF / IPTC / XMP fields:
 *   document title  (IPTC ObjectName / XMP dc:title)       → title
 *   author          (IPTC By-line / XMP Creator / EXIF Artist) → userUrl
 *   author title    (IPTC By-lineTitle / XMP AuthorsPosition)  → userName
 *   website(s)      (XMP Iptc4xmpCore CiUrlWork)            → postUrl
 *   source          (IPTC Source / XMP Source)               → directUrl
 *   creation date   (IPTC DateCreated / EXIF DateTimeOriginal) → date (YYYY-MM-DD)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_DIR = path.resolve('./assets/fa_archive');
const DEST_DIR = path.resolve('./docs/resources/fa_archive');
const JSON_OUT = path.join(DEST_DIR, 'index.json');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg']);

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
// Metadata extraction (EXIF / IPTC / XMP via exiftool-vendored)
// ---------------------------------------------------------------------------

const { exiftool } = require('exiftool-vendored');

async function closeExiftool() {
    await exiftool.end();
}

/**
 * Format a date value to YYYY-MM-DD.
 * Handles: JS Date, exiftool-vendored ExifDateTime (has .year/.month/.day), ISO strings, YYYYMMDD strings.
 * @param {Date|object|string|undefined} val
 * @returns {string|null}
 */
function formatDate(val) {
    if (!val) return null;
    // exiftool-vendored ExifDateTime object
    if (typeof val === 'object' && typeof val.year === 'number') {
        const mm = String(val.month).padStart(2, '0');
        const dd = String(val.day).padStart(2, '0');
        return `${val.year}-${mm}-${dd}`;
    }
    if (val instanceof Date && !isNaN(val)) return val.toISOString().slice(0, 10);
    if (typeof val === 'string') {
        // IPTC DateCreated: "YYYYMMDD"
        if (/^\d{8}$/.test(val.trim())) {
            const s = val.trim();
            return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
        }
        const m = val.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})/);
        if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    }
    return null;
}

/** Returns true if v is an exiftool-vendored ExifDateTime/ExifDate/ExifTime object. */
function isExifDate(v) {
    return v !== null && typeof v === 'object' && typeof v._ctor === 'string' && v._ctor.startsWith('Exif');
}

/**
 * Pick the first truthy string from a list of candidates.
 * Handles arrays (takes first element). Skips Date and ExifDateTime objects.
 * @param {...any} candidates
 * @returns {string|undefined}
 */
function first(...candidates) {
    for (const v of candidates) {
        if (!v) continue;
        if (Array.isArray(v)) { if (v[0] && typeof v[0] === 'string') return v[0].trim(); continue; }
        if (v instanceof Date || isExifDate(v)) continue;
        if (typeof v === 'object') continue; // skip unknown objects
        const s = String(v).trim();
        if (s) return s;
    }
    return undefined;
}

/**
 * Expand a multi-artist URL field into parallel arrays.
 *
 * Two syntaxes are supported:
 *
 *   Pipe-separated (different base URLs):
 *     https://www.furaffinity.net/gallery/alice|https://vgen.co/bob
 *     AuthorTitle: Alice|Bob
 *
 *   Comma-separated (same base URL, FA-style username segment):
 *     https://www.furaffinity.net/user/alice,bob,carol/
 *     AuthorTitle: Alice,Bob,Carol
 *
 * Returns { userUrl, userName } where both are arrays when multiple artists are
 * detected, or plain strings (pass-through) for a single artist.
 *
 * @param {string|undefined} url
 * @param {string|undefined} name
 * @returns {{ userUrl?: string|string[], userName?: string|string[] }}
 */
function expandUserUrl(url, name) {
    if (!url) return {};

    // --- Pipe-separated: each segment may itself be a comma-group or a single URL ---
    if (url.includes('|')) {
        const urlSegments = url.split('|').map(u => u.trim()).filter(Boolean);
        const nameSegments = name ? name.split('|').map(n => n.trim()).filter(Boolean) : [];

        const flatUrls = [];
        const flatNames = [];
        urlSegments.forEach(function (seg, i) {
            // Recursively expand each pipe segment (handles comma-groups within a segment)
            const expanded = expandUserUrl(seg, nameSegments[i]);
            if (Array.isArray(expanded.userUrl)) {
                flatUrls.push(...expanded.userUrl);
                flatNames.push(...(Array.isArray(expanded.userName) ? expanded.userName : [expanded.userName || seg]));
            } else if (expanded.userUrl) {
                flatUrls.push(expanded.userUrl);
                // Fall back to last path segment as display name when userName is absent
                flatNames.push(expanded.userName || expanded.userUrl.replace(/\/+$/, '').split('/').pop() || expanded.userUrl);
            }
        });

        if (flatUrls.length === 0) { const out = {}; out.userUrl = url; if (name) out.userName = name; return out; }
        if (flatUrls.length === 1) { const out = { userUrl: flatUrls[0] }; if (flatNames[0]) out.userName = flatNames[0]; return out; }
        return { userUrl: flatUrls, userName: flatNames };
    }

    // --- Comma-separated: shared base URL, multiple usernames in path segment ---
    const m = url.match(/^(.*\/(?:user|gallery)\/)([^/]+)(\/?)$/);
    if (!m || !m[2].includes(',')) {
        const out = {};
        out.userUrl = url;
        if (name) out.userName = name;
        return out;
    }
    const base = m[1]; // e.g. "https://www.furaffinity.net/user/"
    const usernames = m[2].split(',').map(u => u.trim()).filter(Boolean);
    const userUrls = usernames.map(u => base + u + '/');
    // Use comma-split name when counts match; otherwise fall back to URL slugs
    const nameSegments = name ? name.split(',').map(n => n.trim()).filter(Boolean) : [];
    const userNames = nameSegments.length === usernames.length ? nameSegments : usernames;
    return { userUrl: userUrls, userName: userNames };
}

/**
 * Extract structured metadata from an image file using standard EXIF/IPTC/XMP fields.
 *
 * Field mapping (software label → standard field → JSON key):
 *   document title  → IPTC ObjectName / XMP Title                 → title
 *   author          → IPTC By-line / XMP Creator / EXIF Artist     → userUrl
 *   author title    → IPTC By-lineTitle / XMP AuthorsPosition      → userName
 *   website(s)      → XMP WebStatement / CiUrlWork                 → postUrl
 *   source          → IPTC Source / XMP Source / dc:source         → directUrl
 *   creation date   → IPTC DateCreated / XMP CreateDate            → date
 *
 * @param {string} filePath
 * @returns {Promise<object|null>}
 */
async function extractMetadata(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.svg') return null;

    let raw;
    try {
        raw = await exiftool.read(filePath);
    } catch {
        return null;
    }
    if (!raw) return null;

    const result = {};

    const title = first(raw.ObjectName, raw.Title);
    if (title) result.title = title;

    const userUrl = first(raw.By_line ?? raw['By-line'], raw.Artist, raw.Creator);
    const userName = first(raw.By_lineTitle ?? raw['By-lineTitle'], raw.AuthorsPosition);
    const artistFields = expandUserUrl(userUrl, userName);
    if (artistFields.userUrl !== undefined) result.userUrl = artistFields.userUrl;
    if (artistFields.userName !== undefined) result.userName = artistFields.userName;

    const postUrl = first(raw.WebStatement, raw.CiUrlWork);
    if (postUrl) result.postUrl = postUrl;

    const directUrl = first(raw.Source, raw.PhSource);
    if (directUrl) result.directUrl = directUrl;

    const date = formatDate(raw.DateCreated ?? raw.CreateDate ?? raw.DateTimeOriginal);
    if (date) result.date = date;


    return Object.keys(result).length > 0 ? result : null;
}

// ---------------------------------------------------------------------------
// Destination sync (delete files/dirs in dest that no longer exist in source)
// ---------------------------------------------------------------------------

/**
 * Delete any files in destDir that are not in the sourceSet.
 * @param {string} destDir
 * @param {Set<string>} sourceSet  – expected filenames (basename only)
 */
function syncDestFiles(destDir, sourceSet) {
    if (!fs.existsSync(destDir)) return;
    for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!sourceSet.has(entry.name)) {
            fs.rmSync(path.join(destDir, entry.name));
            console.log(`  ${c.red}✗ removed${c.reset} ${path.relative(DEST_DIR, path.join(destDir, entry.name)).replace(/\\/g, '/')}`);
        }
    }
}

/**
 * Delete any subdirectories in destDir that are not in the sourceDirSet.
 * Also removes the directory itself if it still exists and is empty.
 * @param {string} destDir
 * @param {Set<string>} sourceDirSet  – expected directory names
 */
function syncDestDirs(destDir, sourceDirSet) {
    if (!fs.existsSync(destDir)) return;
    for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!sourceDirSet.has(entry.name)) {
            fs.rmSync(path.join(destDir, entry.name), { recursive: true });
            console.log(`  ${c.red}✗ removed dir${c.reset} ${path.relative(DEST_DIR, path.join(destDir, entry.name)).replace(/\\/g, '/')}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * Sort entries newest-first by date (YYYY-MM-DD string comparison works correctly).
 * Entries without a date sort alphabetically by filename after all dated entries.
 * Entries sharing the same date sort alphabetically by filename.
 * @param {{ file: string, date?: string }[]} entries
 */
function sortEntries(entries) {
    /** Strip extension for comparison so e.g. "fa_logo" sorts before "fa_logo_axexual". */
    const stem = (f) => f.replace(/\.[^.]+$/, '');
    return entries.slice().sort(function (a, b) {
        const hasA = !!a.date;
        const hasB = !!b.date;
        if (hasA && hasB) {
            // Newest first; fall back to filename when dates are equal
            return b.date < a.date ? -1 : b.date > a.date ? 1 : stem(a.file).localeCompare(stem(b.file));
        }
        if (hasA) return -1; // dated before undated
        if (hasB) return 1;
        return stem(a.file).localeCompare(stem(b.file)); // both undated: alphabetical
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    if (!fs.existsSync(SOURCE_DIR)) {
        console.error(`${c.red}✗ Source directory not found: ${SOURCE_DIR}${c.reset}`);
        process.exit(1);
    }

    fs.mkdirSync(DEST_DIR, { recursive: true });

    const categories = fs.readdirSync(SOURCE_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    // Remove dest category dirs that no longer have a source counterpart
    syncDestDirs(DEST_DIR, new Set(categories));

    const index = {};
    let totalImages = 0;
    let totalWithMeta = 0;

    for (const category of categories) {
        const srcCatDir = path.join(SOURCE_DIR, category);
        const destCatDir = path.join(DEST_DIR, category);
        fs.mkdirSync(destCatDir, { recursive: true });

        // --- Reworked/processed images (files directly in category folder) ---
        const reworkedFiles = fs.readdirSync(srcCatDir, { withFileTypes: true })
            .filter(f => f.isFile() && IMAGE_EXTS.has(path.extname(f.name).toLowerCase()))
            .map(f => f.name)
            .sort();

        index[category] = [];
        for (const file of reworkedFiles) {
            const srcFile = path.join(srcCatDir, file);
            fs.copyFileSync(srcFile, path.join(destCatDir, file));
            totalImages++;

            const meta = await extractMetadata(srcFile);
            const entry = { file, ...meta };
            if (meta) totalWithMeta++;
            index[category].push(entry);

            const metaStatus = meta
                ? `${c.green}✓ meta${c.reset}`
                : `${c.yellow}– no meta${c.reset}`;
            console.log(`  ${c.cyan}${category}/${file}${c.reset} ${metaStatus}`);
        }
        index[category] = sortEntries(index[category]);
        syncDestFiles(destCatDir, new Set(reworkedFiles));

        // --- Originals (category/original/ subfolder, with metadata) ---
        const srcOrigDir = path.join(srcCatDir, 'original');
        const destOrigDir = path.join(destCatDir, 'original');
        const originalsKey = `${category}-originals`;

        if (fs.existsSync(srcOrigDir) && fs.statSync(srcOrigDir).isDirectory()) {
            fs.mkdirSync(destOrigDir, { recursive: true });

            const origFiles = fs.readdirSync(srcOrigDir)
                .filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
                .sort();

            index[originalsKey] = [];
            for (const file of origFiles) {
                const srcFile = path.join(srcOrigDir, file);
                fs.copyFileSync(srcFile, path.join(destOrigDir, file));
                totalImages++;

                const meta = await extractMetadata(srcFile);
                const entry = { file, ...meta };
                if (meta) totalWithMeta++;
                index[originalsKey].push(entry);

                const metaStatus = meta
                    ? `${c.green}✓ meta${c.reset}`
                    : `${c.yellow}– no meta${c.reset}`;
                console.log(`  ${c.cyan}${category}/original/${file}${c.reset} ${metaStatus}`);
            }
            index[originalsKey] = sortEntries(index[originalsKey]);
            syncDestFiles(destOrigDir, new Set(origFiles));

            console.log(`${c.blue}[${category}]${c.reset} ${reworkedFiles.length} reworked + ${origFiles.length} original(s)`);
        } else {
            console.log(`${c.blue}[${category}]${c.reset} ${reworkedFiles.length} reworked image(s)`);
        }
    }

    fs.writeFileSync(JSON_OUT, JSON.stringify(index, null, 2), 'utf8');

    console.log(`\n${c.green}✓ Generated ${JSON_OUT}${c.reset}`);
    console.log(`  ${totalImages} image(s) total, ${totalWithMeta} with metadata`);
    console.log(`  Images copied to ${DEST_DIR}`);
}

main()
    .catch(err => {
        console.error(`${c.red}✗ ${err.message}${c.reset}`);
        process.exit(1);
    })
    .finally(() => closeExiftool());
