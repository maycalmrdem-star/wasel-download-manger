(() => {
  const paths = Object.freeze({
    add: '<path d="M12 5v14M5 12h14"/>',
    resume: '<path d="m8 5 11 7-11 7z"/>',
    pause: '<path d="M8 5h3v14H8zM15 5h3v14h-3z"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    delete: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    clear: '<path d="m5 12 4 4L19 6"/>',
    settings: '<path d="M4 7h8m4 0h4M4 17h3m4 0h9"/><circle cx="14" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    schedule: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    export: '<path d="M12 16V4m-5 5 5-5 5 5M5 14v5h14v-5"/>',
    import: '<path d="M12 8v12m-5-5 5 5 5-5M5 4h14v5"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m16 16 4 4"/>',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    archive: '<path d="M4 4h16v5H4zM6 9v11h12V9M10 13h4"/>',
    document: '<path d="M6 3h8l4 4v14H6zM14 3v5h5M9 12h6m-6 4h6"/>',
    media: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    software: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4m0-13v5m-3-3 3 3 3-3"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 17 5-5 4 4 3-3 4 4"/>',
    queue: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
    browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18m-13-3h.01M6 6h.01m4 0h.01"/>',
    shield: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/>'
  });

  function markup(name, className = 'icon') {
    const path = paths[name];
    if (!path) throw new Error(`Unknown Wasel icon: ${name}`);
    if (!/^[a-zA-Z0-9 _-]+$/.test(className)) throw new Error('Invalid icon class name.');
    return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`;
  }

  function hydrate(root = document) {
    root.querySelectorAll('[data-icon]').forEach((element) => {
      const name = element.dataset.icon;
      element.outerHTML = markup(name, element.className || 'icon');
    });
  }

  window.WaselIcons = Object.freeze({ markup, hydrate });
})();
