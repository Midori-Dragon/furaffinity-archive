(function () {
    /**
     * FA Archive Gallery – Docsify plugin
     *
     * Usage in any .md file:
     *   <div class="fa-gallery" data-category="banners"></div>
     *
     * Optional attributes:
     *   data-hide-empty  – omit the info strip entirely for cards that have no metadata
     *   data-max="N"     – show at most N images (applied after sorting)
     *
     * Entries are pre-sorted by the build script: newest date first, undated alphabetically after.
     *
     * Reads docs/resources/fa_archive/index.json, renders a card grid,
     * and opens full-size images in a GLightbox lightbox.
     *
     * The JSON is fetched once and cached for the lifetime of the page.
     */
    let _indexCache = null;

    async function fetchIndex(baseUrl) {
        if (_indexCache) return _indexCache;
        const url = baseUrl + 'resources/fa_archive/index.json';
        const res = await fetch(url);
        if (!res.ok) throw new Error('fa-gallery: could not load ' + url);
        _indexCache = await res.json();
        return _indexCache;
    }

    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    function buildCard(entry, imgBasePath, lightboxClass, hideEmpty) {
        const imgSrc = imgBasePath + encodeURIComponent(entry.file);
        const displayTitle = entry.title || entry.file;

        // --- Thumbnail info strip ---
        const parts = [];
        if (entry.date) {
            const seg = entry.date.split('-');
            const monthName = MONTH_NAMES[parseInt(seg[1], 10) - 1] || '';
            parts.push('<span class="fa-archive-date">' + monthName + ' ' + seg[0] + '</span>');
        }
        if (entry.postUrl)
            parts.push('<a href="' + entry.postUrl + '" target="_blank" rel="noopener">Post</a>');
        if (entry.userUrl)
            parts.push('<a href="' + entry.userUrl + '" target="_blank" rel="noopener">' + (entry.userName || 'Artist') + '</a>');

        const sep = '<span class="fa-archive-sep">|</span>';
        const infoHtml = parts.length
            ? '<div class="fa-archive-card-info">' + parts.join(sep) + '</div>'
            : hideEmpty ? '' : '<div class="fa-archive-card-info"><span class="fa-archive-empty">No metadata</span></div>';

        const titleHtml = entry.title
            ? '<div class="fa-archive-card-title">' + entry.title + '</div>'
            : '';

        // --- Lightbox description HTML ---
        const lbLines = [];
        if (entry.title)
            lbLines.push('<span class="fa-lb-title">' + entry.title + '</span>');
        if (entry.date) {
            const seg = entry.date.split('-');
            const monthName = MONTH_NAMES[parseInt(seg[1], 10) - 1] || '';
            lbLines.push('<span><span class="fa-lb-label">Date:</span> ' + parseInt(seg[2], 10) + '. ' + monthName + ' ' + seg[0] + '</span>');
        }
        if (entry.postUrl)
            lbLines.push('<span><span class="fa-lb-label">Post:</span> <a href="' + entry.postUrl + '" target="_blank" rel="noopener">' + entry.postUrl + '</a></span>');
        if (entry.userUrl)
            lbLines.push('<span><span class="fa-lb-label">Artist:</span> <a href="' + entry.userUrl + '" target="_blank" rel="noopener">' + (entry.userName || entry.userUrl) + '</a></span>');
        if (entry.directUrl)
            lbLines.push('<span><span class="fa-lb-label">Direct:</span> <a href="' + entry.directUrl + '" target="_blank" rel="noopener">' + entry.directUrl + '</a></span>');
        const lbDesc = lbLines.length
            ? '<div class="fa-lb-desc">' + lbLines.join('') + '</div>'
            : '';

        return [
            '<div class="fa-archive-card">',
            '  <a class="fa-archive-thumb glightbox ' + lightboxClass + '"',
            '     href="' + imgSrc + '"',
            '     data-title=""',
            '     data-description="' + lbDesc.replace(/"/g, '&quot;') + '">',
            '    <img src="' + imgSrc + '" alt="' + displayTitle + '" loading="lazy">',
            '  </a>',
            titleHtml,
            infoHtml,
            '</div>',
        ].join('\n');
    }

    function getBaseUrl() {
        // Works whether served locally or from GitHub Pages
        const base = document.querySelector('base');
        if (base) return base.href;
        // Derive from current URL up to the last path component that looks like a page
        let url = window.location.href.split('?')[0].split('#')[0];
        if (!url.endsWith('/')) url = url.substring(0, url.lastIndexOf('/') + 1);
        return url;
    }

    let _lightbox = null;

    function initLightbox() {
        if (_lightbox) { _lightbox.destroy(); }
        _lightbox = GLightbox({ selector: '.glightbox', touchNavigation: true, loop: true, zoomable: true });
    }

    window.$docsify = window.$docsify || {};
    window.$docsify.plugins = (window.$docsify.plugins || []).concat(function (hook) {
        hook.doneEach(function () {
            const containers = document.querySelectorAll('.fa-gallery[data-category]');
            if (!containers.length) return;

            const baseUrl = getBaseUrl();

            fetchIndex(baseUrl).then(function (index) {
                containers.forEach(function (el) {
                    const category = el.getAttribute('data-category');
                    const entries = index[category];
                    const isOriginals = category.endsWith('-originals');
                    const baseCategory = isOriginals ? category.slice(0, -('-originals'.length)) : category;
                    const imgBase = baseUrl + 'resources/fa_archive/' + baseCategory + (isOriginals ? '/original/' : '/');
                    const lbClass = 'fa-gallery-lb-' + category.replace(/[^a-z0-9]/gi, '-');
                    const hideEmpty = el.hasAttribute('data-hide-empty');
                    const maxAttr = el.getAttribute('data-max');
                    const maxCount = maxAttr !== null ? parseInt(maxAttr, 10) : Infinity;

                    if (!entries || entries.length === 0) {
                        el.innerHTML = '<p class="fa-archive-empty">No images found for category &ldquo;' + category + '&rdquo;.</p>';
                        return;
                    }

                    const cards = entries.slice(0, maxCount).map(function (e) { return buildCard(e, imgBase, lbClass, hideEmpty); });
                    el.innerHTML = '<div class="fa-archive-gallery">' + cards.join('') + '</div>';
                });

                initLightbox();
            }).catch(function (err) {
                console.error(err);
                containers.forEach(function (el) {
                    el.innerHTML = '<p class="fa-archive-empty">Could not load archive index.</p>';
                });
            });
        });
    });
})();
