(() => {
    'use strict';

    const menuToggle = document.querySelector('[data-menu-toggle]');
    const mobileNavigation = document.querySelector('[data-mobile-navigation]');

    if (menuToggle && mobileNavigation) {
        let lastFocusedElement = null;
        const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

        const closeMenu = ({restoreFocus = false} = {}) => {
            mobileNavigation.classList.remove('is-open');
            menuToggle.setAttribute('aria-expanded', 'false');
            menuToggle.querySelector('.sr-only').textContent = 'メニューを開く';
            document.body.classList.remove('menu-open');
            if (restoreFocus && lastFocusedElement) {
                lastFocusedElement.focus();
            }
        };

        const openMenu = () => {
            lastFocusedElement = document.activeElement;
            mobileNavigation.classList.add('is-open');
            menuToggle.setAttribute('aria-expanded', 'true');
            menuToggle.querySelector('.sr-only').textContent = 'メニューを閉じる';
            document.body.classList.add('menu-open');
            const firstLink = mobileNavigation.querySelector('a');
            if (firstLink) firstLink.focus();
        };

        menuToggle.addEventListener('click', () => {
            const isOpen = mobileNavigation.classList.contains('is-open');
            if (isOpen) closeMenu({restoreFocus: true});
            else openMenu();
        });

        mobileNavigation.addEventListener('click', (event) => {
            if (event.target.closest('a')) closeMenu();
        });

        document.addEventListener('keydown', (event) => {
            if (!mobileNavigation.classList.contains('is-open')) return;

            if (event.key === 'Escape') {
                closeMenu({restoreFocus: true});
                return;
            }

            if (event.key === 'Tab') {
                const focusable = Array.from(mobileNavigation.querySelectorAll(focusableSelector));
                if (!focusable.length) {
                    event.preventDefault();
                    return;
                }

                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        });

        document.addEventListener('click', (event) => {
            if (mobileNavigation.classList.contains('is-open') && !event.target.closest('.site-header')) {
                closeMenu();
            }
        });

        window.addEventListener('resize', () => {
            if (window.innerWidth >= 780) closeMenu();
        });
    }

    // Ghost editor embeds are authored by the content team. The theme adds
    // safe defaults without rewriting the source URL or exposing it elsewhere.
    document.querySelectorAll('iframe').forEach((frame) => {
        if (!frame.getAttribute('loading')) frame.setAttribute('loading', 'lazy');
        if (!frame.getAttribute('title')) frame.setAttribute('title', '講義動画');
        if (!frame.hasAttribute('allowfullscreen')) frame.setAttribute('allowfullscreen', '');
        if (!frame.getAttribute('allow')) frame.setAttribute('allow', 'fullscreen; picture-in-picture');
        frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    });

    // Keep the count announcement useful on every paginated lecture page.
    document.querySelectorAll('[data-lecture-count]').forEach((countElement) => {
        const list = document.querySelector('[data-lecture-list]');
        if (!list) return;
        const total = list.querySelectorAll('[data-lecture-card]').length;
        countElement.textContent = total === 1 ? 'このページに1件' : `このページに${total}件`;
    });
})();
