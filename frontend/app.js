/* SquareYards – Mumbai POC (stable + project density, hardened)
   - Prevents blank Month/Asset/BHK (adds default options if needed)
   - Safe fallbacks when building data URLs
   - Project counts work with points off + heatmap on
   - v3-safe dashes; robust filters and deselect behavior
*/

(async function () {
  const cfg  = await fetch('./config.json').then(r => r.json());
  const dims = await fetch('./dims.json').then(r => (r.ok ? r.json() : ({
    months: [], bhk: [], assets: [], city: null, micromarkets: [], localities: []
  })));

  mapboxgl.accessToken = (cfg.mapboxToken || '').toString().replace(/[\s\u00A0]/g, '');
  const dataRoot = cfg.dataRoot.startsWith('/') ? cfg.dataRoot
    : '/' + cfg.dataRoot.replace(/^\.\//, '').replace(/^\.\.\//, '');

  const center = dims.city?.center || [72.8777, 19.0760];
  const zoom   = dims.city?.zoom   || 10;

  const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/standard',
    center, zoom, pitch: 0, bearing: 0, antialias: true
  });
  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.on('error', e => {
    const msg = String(e?.error?.message || '');
    if (msg.includes('Unauthorized') || msg.includes('NetworkError') || msg.includes('Style')) {
      console.error('[mapbox error]', e.error);
    }
  });

  // ---- UI ----
  const ui = {
    metric:  document.getElementById('metric'),
    month:   document.getElementById('month'),
    asset:   document.getElementById('asset'),
    bhk:     document.getElementById('bhk'),
    theme:   document.getElementById('theme'),
    apply:   document.getElementById('apply'),
    legend:  document.getElementById('legend'),
    stats:   document.getElementById('stats'),
    mm:      document.getElementById('mm'),
    loc:     document.getElementById('loc'),
    tMM:     document.getElementById('toggle-mm'),
    tRoads:  document.getElementById('toggle-roads'),
    tProjects: document.getElementById('toggle-projects'),
    tDensity:  document.getElementById('toggle-density'),
    status:    document.getElementById('status')
  };

  // Utility: write list to a select
  function setOptions(el, values, mapFn = v => ({ value: v, label: v })) {
    if (!el) return;
    el.innerHTML = values.map(v => {
      const { value, label } = mapFn(v);
      return `<option value="${value}">${label}</option>`;
    }).join('');
  }

  // Utility: ensure select has at least one option for desired value
  function ensureOption(el, value) {
    if (!el || !value) return;
    const opts = Array.from(el.options || []);
    const has = opts.some(o => o.value === value);
    if (!has) {
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = value;
      el.appendChild(opt);
    }
    el.value = value;
  }

  // Populate (if dims provided)
  if (Array.isArray(dims.months) && dims.months.length) {
    setOptions(ui.month, dims.months);
  }
  if (Array.isArray(dims.assets) && dims.assets.length) {
    setOptions(ui.asset, dims.assets, a => ({ value: a.code, label: a.label || a.code }));
  }
  if (Array.isArray(dims.bhk) && dims.bhk.length) {
    setOptions(ui.bhk, dims.bhk, b => ({ value: b.code, label: b.label || b.code }));
  }
  if (Array.isArray(dims.micromarkets) && dims.micromarkets.length && ui.mm) {
    ui.mm.innerHTML = '<option value="">All Micromarkets</option>' +
      dims.micromarkets.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  }
  if (Array.isArray(dims.localities) && dims.localities.length && ui.loc) {
    ui.loc.innerHTML = '<option value="">All Localities</option>' +
      dims.localities.map(l => `<option value="${l.id}">${l.name}</option>`).join('');
  }

  // Defaults + guarantee options exist even when dims were empty
  if (cfg.default) {
    if (cfg.default.metric && ui.metric) ui.metric.value = cfg.default.metric;
    if (cfg.default.month  && ui.month)  ensureOption(ui.month, cfg.default.month);
    if (cfg.default.asset  && ui.asset)  ensureOption(ui.asset, cfg.default.asset);
    if (cfg.default.bhk    && ui.bhk)    ensureOption(ui.bhk,   cfg.default.bhk);
  }
  // If still empty, add a first fallback from dims (if any)
  if (ui.month && !ui.month.options.length && dims.months?.[0]) ensureOption(ui.month, dims.months[0]);
  if (ui.asset && !ui.asset.options.length && dims.assets?.[0]?.code) ensureOption(ui.asset, dims.assets[0].code);
  if (ui.bhk   && !ui.bhk.options.length   && dims.bhk?.[0]?.code)   ensureOption(ui.bhk,   dims.bhk[0].code);

  if (ui.theme) ui.theme.value = 'day';
  if (ui.tProjects) { ui.tProjects.checked = false; ui.tProjects.disabled = true; }
  if (ui.tDensity)  { ui.tDensity.checked  = false; ui.tDensity.disabled  = true; }
  if (ui.status)    { ui.status.value      = '__all__'; ui.status.disabled = true; }

  // Safe read of selects
  const readSel = (el) => (el?.value ?? '').toString().trim();
  function getFilters() {
    // Resolve to non-empty strings using UI -> dims -> cfg.default
    let metric = readSel(ui.metric) || cfg.default?.metric || 'yield';
    let month  = readSel(ui.month)  || cfg.default?.month  || (dims.months?.[0] || '');
    let asset  = readSel(ui.asset)  || cfg.default?.asset  || (dims.assets?.[0]?.code || '');
    let bhk    = readSel(ui.bhk)    || cfg.default?.bhk    || (dims.bhk?.[0]?.code || '');
    return { metric, month, asset, bhk };
  }

  // ---- Colors/legend helpers ----
  const fmtINR = v => v == null ? '—' : '₹ ' + Intl.NumberFormat('en-IN').format(v);
  const fmtPct = v => v == null ? '—' : v.toFixed(2) + '%';

  function colorStops(values) {
    if (!values || !values.length) return [0,1,2,3,4];
    const sorted = [...values].sort((a,b)=>a-b);
    const q = p => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))))];
    return [q(0.00), q(0.25), q(0.50), q(0.75), q(1.00)];
  }

  const PALETTE_LIGHT = ['#f2f0f7','#cbc9e2','#9e9ac8','#756bb1','#54278f'];
  const PALETTE_DARK  = ['#e5f3ff','#a6d5ff','#66b8ff','#1f90ff','#0060df'];
  const OUTLINE_COLORS = { light:{mm:'#7c3aed',roads:'#0284c7'}, dark:{mm:'#f472b6',roads:'#38bdf8'} };
  const DOT_DASH_LITERAL = ['literal', [0.1, 1.2]];
  const CASING_COLOR_LIGHT = 'rgba(0,0,0,0.35)';
  const CASING_COLOR_DARK  = 'rgba(255,255,255,0.55)';

  function paintExpression(stops, isDark) {
    const neutral = isDark ? '#374151' : '#d1d5db';
    const colors  = isDark ? PALETTE_DARK : PALETTE_LIGHT;
    const expr = ['interpolate', ['linear'], ['number', ['feature-state','value'], -9999],
      -9999, neutral];
    for (let i = 0; i < stops.length; i++) expr.push(stops[i], colors[Math.min(i, colors.length - 1)]);
    return expr;
  }

  function renderLegend(stops, isDark, formatter) {
    const colors = isDark ? PALETTE_DARK : PALETTE_LIGHT;
    ui.legend.innerHTML = '';
    for (let i = 0; i < stops.length - 1; i++) {
      const sw = document.createElement('div');
      sw.className = 'legend-swatch';
      sw.style.background = colors[i + 1];
      const label = document.createElement('span');
      label.style.margin = '0 6px 0 4px';
      label.style.color = isDark ? '#e5e7eb' : '#111827';
      label.textContent = `${formatter(stops[i])}–${formatter(stops[i + 1])}`;
      ui.legend.appendChild(sw); ui.legend.appendChild(label);
    }
  }

  // ---- status helpers ----
  const STATUS_ALL = '__all__';
  const STATUS_ALIASES = s => {
    const x = String(s || '').toLowerCase();
    if (x.includes('ready')) return 'Ready to Move';
    if (x.includes('under')) return 'Under Construction';
    if (x.includes('launch')) return 'New Launch';
    return String(s || 'Other');
  };
  function heatmapColorsForStatus(status) {
    const s = STATUS_ALIASES(status);
    if (s === 'Ready to Move') return ['interpolate', ['linear'], ['heatmap-density'], 0,'rgba(22,163,74,0.00)',0.2,'rgba(22,163,74,0.25)',0.4,'rgba(22,163,74,0.45)',0.6,'rgba(22,163,74,0.60)',0.8,'rgba(22,163,74,0.80)',1,'rgba(22,163,74,1)'];
    if (s === 'Under Construction') return ['interpolate', ['linear'], ['heatmap-density'], 0,'rgba(245,158,11,0.00)',0.2,'rgba(245,158,11,0.25)',0.4,'rgba(245,158,11,0.45)',0.6,'rgba(245,158,11,0.60)',0.8,'rgba(245,158,11,0.80)',1,'rgba(245,158,11,1)'];
    if (s === 'New Launch') return ['interpolate', ['linear'], ['heatmap-density'], 0,'rgba(139,92,246,0.00)',0.2,'rgba(139,92,246,0.25)',0.4,'rgba(139,92,246,0.45)',0.6,'rgba(139,92,246,0.60)',0.8,'rgba(139,92,246,0.80)',1,'rgba(139,92,246,1)'];
    return ['interpolate', ['linear'], ['heatmap-density'], 0,'rgba(59,130,246,0.00)',0.2,'rgba(59,130,246,0.25)',0.4,'rgba(59,130,246,0.45)',0.6,'rgba(59,130,246,0.60)',0.8,'rgba(59,130,246,0.80)',1,'rgba(59,130,246,1)'];
  }

  // ---- state ----
  const sel = { mm: '', loc: '' };
  let featureIdType = 'number';
  let ID_KEY   = 'LocalityID';
  let NAME_KEY = 'LocalityName';
  let selectedId = null;
  let isDark = false;
  let projectHoverPopup = null;

  const castId = id => (featureIdType === 'number' ? Number(id) : String(id));
  const projLocExpr = idStr => ['==', ['to-string', ['coalesce', ['get','LocalityID'], ['get','sublocationid']]], String(idStr)];
  const projStatusExpr = status => (status === STATUS_ALL
    ? true
    : ['==', ['downcase', ['coalesce', ['get','Status'], ['get','projectstatus'], '' ] ], String(status).toLowerCase()]);

  // ---- map load ----
  map.on('load', async () => {
    if (map.setConfig) map.setConfig({ lightPreset: 'day', colorScheme: 'light', show3dBuildings: true });

    try {
      map.addSource('mapbox-dem', { type:'raster-dem', url:'mapbox://mapbox.mapbox-terrain-dem-v1', tileSize:512, maxzoom:14 });
      map.setTerrain({ source:'mapbox-dem', exaggeration:1.0 });
      map.addLayer({ id:'sky', type:'sky', paint:{ 'sky-type':'atmosphere', 'sky-atmosphere-sun':[0,90], 'sky-atmosphere-sun-intensity':15 }});
    } catch {}
    map.easeTo({ pitch:60, bearing:20, duration:1000 });

    map.addSource('localities',   { type:'vector', url: cfg.tilesets.localities });
    if (cfg.tilesets.micromarkets) map.addSource('micromarkets', { type:'vector', url: cfg.tilesets.micromarkets });
    if (cfg.tilesets.roads)        map.addSource('roads',        { type:'vector', url: cfg.tilesets.roads });
    if (cfg.tilesets.projects)     map.addSource('projects',     { type:'vector', url: cfg.tilesets.projects });

    map.addLayer({ id:'localities-fill', type:'fill', source:'localities', 'source-layer':cfg.sourceLayers.localities,
      paint:{ 'fill-color':'#d1d5db', 'fill-opacity':['case',['boolean',['feature-state','selected'],false],0.95,0.75] }});
    map.addLayer({ id:'localities-outline', type:'line', source:'localities', 'source-layer':cfg.sourceLayers.localities,
      paint:{ 'line-color':['case',['boolean',['feature-state','selected'],false],'#111827','#7c7c7c'], 'line-width':['case',['boolean',['feature-state','selected'],false],1.8,0.8] }});
    map.addLayer({ id:'localities-labels', type:'symbol', source:'localities', 'source-layer':cfg.sourceLayers.localities, minzoom:11.2,
      layout:{ 'text-field':['coalesce',['get','LocalityName'],['get','sublocationname']], 'text-size':11, 'text-variable-anchor':['top','bottom','left','right'], 'text-justify':'auto', 'text-padding':2 },
      paint:{ 'text-color':'#111827','text-halo-color':'#fff','text-halo-width':1 }});

    if (cfg.sourceLayers.micromarkets) {
      map.addLayer({ id:'mm-outline-casing', type:'line', source:'micromarkets', 'source-layer':cfg.sourceLayers.micromarkets,
        layout:{ 'line-cap':'round','line-join':'round' },
        paint:{ 'line-color':CASING_COLOR_LIGHT, 'line-width':['interpolate',['linear'],['zoom'],9,2.2,12,3.2,14,4.4], 'line-opacity':0.9, 'line-blur':0.2 }});
      map.addLayer({ id:'mm-outline', type:'line', source:'micromarkets', 'source-layer':cfg.sourceLayers.micromarkets,
        layout:{ 'line-cap':'round','line-join':'round' },
        paint:{ 'line-color':OUTLINE_COLORS.light.mm, 'line-width':['interpolate',['linear'],['zoom'],9,1.4,12,2.4,14,3.4], 'line-opacity':0.95, 'line-dasharray':['literal',[0.1,1.2]] }});
      map.addLayer({ id:'mm-labels', type:'symbol', source:'micromarkets', 'source-layer':cfg.sourceLayers.micromarkets, maxzoom:11.2,
        layout:{ 'text-field':['coalesce',['get','MicroMarketName'],['get','locationname']], 'text-size':13 },
        paint:{ 'text-color':'#374151','text-halo-color':'#fff','text-halo-width':1 }});
    }

    if (cfg.sourceLayers.roads) {
      map.addLayer({ id:'roads-line-casing', type:'line', source:'roads', 'source-layer':cfg.sourceLayers.roads,
        layout:{ 'line-cap':'round','line-join':'round' },
        paint:{ 'line-color':CASING_COLOR_LIGHT, 'line-width':['interpolate',['linear'],['zoom'],10,2,12,3,14,4.2,16,5.2], 'line-opacity':0.9, 'line-blur':0.15 }});
      map.addLayer({ id:'roads-line', type:'line', source:'roads', 'source-layer':cfg.sourceLayers.roads,
        layout:{ 'line-cap':'round','line-join':'round' },
        paint:{ 'line-color':OUTLINE_COLORS.light.roads, 'line-width':['interpolate',['linear'],['zoom'],10,1.2,12,2,14,3.2,16,4.2], 'line-opacity':0.95, 'line-dasharray':['literal',[0.1,1.2]] }});
    }

    if (cfg.sourceLayers.projects) {
      map.addLayer({ id:'projects-point', type:'circle', source:'projects', 'source-layer':cfg.sourceLayers.projects,
        paint:{
          'circle-radius':['interpolate',['linear'],['zoom'],10,2,14,6,16,10],
          'circle-color':['match',['get','Status'], 'Ready to Move','#16a34a','Under Construction','#f59e0b', '#3b82f6'],
          'circle-stroke-color':'#fff','circle-stroke-width':0.8,'circle-opacity':0.95
        }, layout:{ 'visibility':'none' }});

      map.addLayer({ id:'projects-heat', type:'heatmap', source:'projects', 'source-layer':cfg.sourceLayers.projects,
        layout:{ 'visibility':'none' },
        paint:{
          'heatmap-weight':1,
          'heatmap-intensity':['interpolate',['linear'],['zoom'],10,0.9,14,1.25],
          'heatmap-radius':['interpolate',['linear'],['zoom'],10,14,14,28],
          'heatmap-opacity':['interpolate',['linear'],['zoom'],10,0.7,14,0.6],
          'heatmap-color':heatmapColorsForStatus(STATUS_ALL)
        }});
    }

    // Detect id fields
    try {
      const sample = map.querySourceFeatures('localities', { sourceLayer: cfg.sourceLayers.localities })[0];
      if (sample) {
        featureIdType = typeof sample.id;
        const p = sample.properties || {};
        if ('LocalityID' in p || 'LocalityName' in p) { ID_KEY='LocalityID'; NAME_KEY='LocalityName'; }
        else if ('sublocationid' in p || 'sublocationname' in p) { ID_KEY='sublocationid'; NAME_KEY='sublocationname'; }
      }
    } catch {}

    // ---- Choropleth ----
    async function applyChoropleth() {
      const { metric, month, asset, bhk } = getFilters();
      if (!month || !asset || !bhk) {
        console.warn('[applyChoropleth] missing filters', { metric, month, asset, bhk });
        ui.legend.innerHTML = '(no data)';
        map.setPaintProperty('localities-fill','fill-color', '#d1d5db');
        return;
      }
      const url = `${dataRoot}/choropleth/${encodeURIComponent(metric)}/${encodeURIComponent(month)}/${encodeURIComponent(asset)}/${encodeURIComponent(bhk)}.json`;
      let arr = [];
      try {
        const rsp = await fetch(url);
        if (!rsp.ok) throw new Error(`HTTP ${rsp.status}`);
        arr = await rsp.json();
      } catch (e) {
        console.warn('Choropleth fetch failed:', e);
        ui.legend.innerHTML = '(no data)';
        map.setPaintProperty('localities-fill','fill-color', '#d1d5db');
        return;
      }
      const values = arr.map(d => Number(d.value)).filter(Number.isFinite);
      const stops  = colorStops(values);
      const fmt    = (metric === 'yield') ? (v => v.toFixed(2) + '%') : (v => Intl.NumberFormat('en-IN').format(v));
      renderLegend(stops, isDark, fmt);
      const layerName = cfg.sourceLayers.localities;
      for (const d of arr) {
        const targetId = castId(d.id);
        map.setFeatureState({ source:'localities', sourceLayer: layerName, id: targetId }, { value: Number(d.value) });
      }
      map.setPaintProperty('localities-fill','fill-color', paintExpression(stops, isDark));
      map.setPaintProperty('localities-outline','line-color', isDark ? '#9ca3af' : '#7c7c7c');
      map.setPaintProperty('localities-labels','text-color', isDark ? '#e5e7eb' : '#111827');
    }

    // ---- Filters (MM/Locality + Projects) ----
    function matchFilterForIds(ids) { return ['match', ['id'], ids, true, false]; }

    function setSelectionFilters() {
      if (sel.loc) {
        const id = castId(sel.loc);
        const filter = ['==', ['id'], id];
        map.setFilter('localities-fill', filter);
        map.setFilter('localities-outline', filter);
        map.setFilter('localities-labels', filter);
      } else if (sel.mm) {
        const ids = (dims.localities || []).filter(l => String(l.microMarketId ?? '') === String(sel.mm)).map(l => castId(l.id));
        const filter = ids.length ? matchFilterForIds(ids) : null;
        map.setFilter('localities-fill', filter);
        map.setFilter('localities-outline', filter);
        map.setFilter('localities-labels', filter);
      } else {
        map.setFilter('localities-fill', null);
        map.setFilter('localities-outline', null);
        map.setFilter('localities-labels', null);
      }

      if (!cfg.sourceLayers.projects) return;

      const havePoints = !!map.getLayer('projects-point');
      const haveHeat   = !!map.getLayer('projects-heat');

      if (sel.loc) {
        if (ui.tProjects) { ui.tProjects.disabled = false; ui.tProjects.checked = true; }
        if (havePoints) {
          map.setLayoutProperty('projects-point', 'visibility', 'visible');
          map.setFilter('projects-point', projLocExpr(sel.loc));
        }
        if (ui.tDensity) ui.tDensity.disabled = false;
        if (ui.status)   ui.status.disabled = !ui.tDensity.checked;

      } else if (sel.mm) {
        if (ui.tProjects?.checked && havePoints) {
          const f = ['any',
            ['==', ['coalesce', ['to-string',['get','MicroMarketID']], '' ], String(sel.mm)],
            ['==', ['coalesce', ['to-string',['get','locationid']],    '' ], String(sel.mm)]
          ];
          map.setFilter('projects-point', f);
          map.setLayoutProperty('projects-point','visibility','visible');
        }
        if (ui.tDensity) { ui.tDensity.checked = false; ui.tDensity.disabled = true; }
        if (haveHeat) { map.setLayoutProperty('projects-heat','visibility','none'); map.setFilter('projects-heat', null); }
        if (ui.status) { ui.status.value = STATUS_ALL; ui.status.disabled = true; }

      } else {
        if (havePoints) {
          const vis = (ui.tProjects && ui.tProjects.checked) ? 'visible' : 'none';
          map.setLayoutProperty('projects-point', 'visibility', vis);
          if (!ui.tProjects?.checked) map.setFilter('projects-point', null);
        }
        if (ui.tDensity) { ui.tDensity.checked = false; ui.tDensity.disabled = true; }
        if (haveHeat) { map.setLayoutProperty('projects-heat','visibility','none'); map.setFilter('projects-heat', null); }
        if (ui.status) { ui.status.value = STATUS_ALL; ui.status.disabled = true; }
      }
    }

    function hideProjectsAll() {
      if (cfg.sourceLayers.projects) {
        if (map.getLayer('projects-point')) {
          map.setLayoutProperty('projects-point','visibility','none');
          map.setFilter('projects-point', null);
        }
        if (map.getLayer('projects-heat')) {
          map.setLayoutProperty('projects-heat','visibility','none');
          map.setFilter('projects-heat', null);
        }
      }
      if (ui.tProjects) { ui.tProjects.checked = false; ui.tProjects.disabled = true; }
      if (ui.tDensity)  { ui.tDensity.checked  = false; ui.tDensity.disabled = true; }
      if (ui.status)    { ui.status.value      = STATUS_ALL; ui.status.disabled = true; }
      if (projectHoverPopup) { projectHoverPopup.remove(); projectHoverPopup = null; }
      clearProjectCard();
    }

    async function fitToSelection() {
      const feats = map.queryRenderedFeatures({ layers:['localities-fill'] });
      if (!feats.length) return;
      const bounds = new mapboxgl.LngLatBounds();
      for (const ft of feats) {
        const g = ft.geometry; if (!g) continue;
        const coords = g.type === 'Polygon' ? g.coordinates.flat(1)
                    : g.type === 'MultiPolygon' ? g.coordinates.flat(2) : [];
        coords.forEach(([lng, lat]) => bounds.extend([lng, lat]));
      }
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 40, maxZoom: 14 });
    }

    // ---- Widget helpers ----
    function ensureProjectCard() {
      let card = document.getElementById('proj-card');
      if (!card) {
        card = document.createElement('div');
        card.id = 'proj-card';
        card.style.marginTop  = '10px';
        card.style.borderTop  = '1px solid #e5e7eb';
        card.style.paddingTop = '10px';
        ui.stats.appendChild(card);
      }
      return card;
    }
    function clearProjectCard() { const el = document.getElementById('proj-card'); if (el) el.remove(); }
    const waitIdle = () => new Promise(res => map.once('idle', () => requestAnimationFrame(res)));

    const colorDotClass = status => {
      const s = STATUS_ALIASES(status);
      if (s === 'Ready to Move') return 'dot-rtm';
      if (s === 'Under Construction') return 'dot-uc';
      if (s === 'New Launch') return 'dot-nl';
      return 'dot-oth';
    };

    async function computeProjectCountsForLocality(locId, statusSel) {
      await waitIdle();
      let feats = [];
      const pointsVisible = map.getLayer('projects-point') &&
                            map.getLayoutProperty('projects-point','visibility') === 'visible';
      const heatVisible   = map.getLayer('projects-heat') &&
                            map.getLayoutProperty('projects-heat','visibility') === 'visible';
      if (pointsVisible) feats = map.queryRenderedFeatures({ layers:['projects-point'] });
      else if (heatVisible) feats = map.queryRenderedFeatures({ layers:['projects-heat'] });
      else {
        try { feats = map.querySourceFeatures('projects', { sourceLayer: cfg.sourceLayers.projects }); }
        catch { feats = []; }
      }
      const locStr = String(locId);
      feats = feats.filter(f => String(f.properties?.LocalityID ?? f.properties?.sublocationid ?? '') === locStr);

      const selPretty = (statusSel && statusSel !== STATUS_ALL) ? STATUS_ALIASES(statusSel) : null;
      const counts = new Map(); let total = 0;
      for (const f of feats) {
        const pretty = STATUS_ALIASES(f.properties?.Status ?? f.properties?.projectstatus ?? 'Other');
        if (selPretty && pretty !== selPretty) continue;
        counts.set(pretty, (counts.get(pretty) || 0) + 1); total++;
      }
      return { counts, total };
    }

    async function populateStatusesDropdownForLocality(locId) {
      await waitIdle();
      let feats = [];
      const pointsVisible = map.getLayer('projects-point') &&
                            map.getLayoutProperty('projects-point','visibility') === 'visible';
      const heatVisible   = map.getLayer('projects-heat') &&
                            map.getLayoutProperty('projects-heat','visibility') === 'visible';
      if (pointsVisible) feats = map.queryRenderedFeatures({ layers:['projects-point'] });
      else if (heatVisible) feats = map.queryRenderedFeatures({ layers:['projects-heat'] });
      else {
        try { feats = map.querySourceFeatures('projects', { sourceLayer: cfg.sourceLayers.projects }); }
        catch { feats = []; }
      }
      const locStr = String(locId);
      const set = new Set();
      for (const f of feats) {
        const p = f.properties || {};
        if (String(p.LocalityID ?? p.sublocationid ?? '') !== locStr) continue;
        set.add(STATUS_ALIASES(p.Status ?? p.projectstatus ?? 'Other'));
      }
      const list = Array.from(set.values()).sort();
      ui.status.innerHTML = `<option value="${STATUS_ALL}">All</option>` + list.map(s => `<option value="${s}">${s}</option>`).join('');
      ui.status.disabled = !ui.tDensity.checked;
      // Keep current selection if still valid, else fall back to All
      if (!Array.from(ui.status.options).some(o => o.value === ui.status.value)) ui.status.value = STATUS_ALL;
    }

    async function updateCountsWidget(locId, statusSel) {
      const card = ensureProjectCard();
      const { counts, total } = await computeProjectCountsForLocality(locId, statusSel);
      let badges = '';
      for (const [status, n] of counts.entries()) {
        badges += `<span class="status-badge"><span class="status-dot ${colorDotClass(status)}"></span>${status}: ${n}</span>`;
      }
      if (!badges) badges = '<div style="color:#6b7280;font-size:12px;">No projects found for this selection.</div>';
      card.innerHTML = `
        <div style="font-weight:600; margin-bottom:6px;">Projects in this locality</div>
        <div style="font-size:12px; color:#111827; margin-bottom:8px;">Total: ${total}</div>
        <div>${badges}</div>`;
    }

    // ---- UI listeners ----
    ui.mm?.addEventListener('change', async () => {
      sel.mm = ui.mm.value || ''; sel.loc = ''; if (ui.loc) ui.loc.value = '';
      setSelectionFilters(); await fitToSelection();
      ui.stats.textContent = 'Click a locality to see details here.'; clearProjectCard();
      await applyChoropleth();
    });

    ui.loc?.addEventListener('change', async () => {
      sel.loc = ui.loc.value || '';
      setSelectionFilters(); await fitToSelection();
      if (sel.loc) {
        if (ui.tDensity) ui.tDensity.disabled = false;
        if (ui.tProjects && map.getLayer('projects-point')) {
          map.setLayoutProperty('projects-point', 'visibility', 'visible'); // (fixed)
          map.setFilter('projects-point', projLocExpr(sel.loc));
        }
        await populateStatusesDropdownForLocality(sel.loc);
        await updateCountsWidget(sel.loc, ui.status.value);
      } else {
        hideProjectsAll();
      }
      await applyChoropleth();
    });

    function setLocalitySelected(id, on) {
      const layerName = cfg.sourceLayers.localities;
      map.setFeatureState({ source:'localities', sourceLayer: layerName, id: castId(id) }, { selected: !!on });
    }

    function animateProjectsForLocality(locId) {
      if (!cfg.sourceLayers.projects || !map.getLayer('projects-point')) return;
      const start = performance.now();
      const base = ['interpolate',['linear'],['zoom'], 10,2,14,6,16,10];
      const cond = projLocExpr(locId);
      function frame(ts) {
        const t = Math.min(1, (ts - start) / 450);
        const bump = 1 + 0.35 * (1 - Math.cos(Math.PI * t));
        const expr = ['interpolate',['linear'],['zoom'],
          10, ['case', cond, 2*bump, 2],
          14, ['case', cond, 6*bump, 6],
          16, ['case', cond,10*bump,10]];
        map.setPaintProperty('projects-point','circle-radius', expr);
        if (t < 1) requestAnimationFrame(frame); else map.setPaintProperty('projects-point','circle-radius', base);
      }
      requestAnimationFrame(frame);
    }

    async function onClickLocality(e) {
      const feats = map.queryRenderedFeatures(e.point, { layers:['localities-fill'] });
      if (!feats.length) return;
      const f = feats[0];
      const locId = (f.id != null ? f.id : undefined) ??
        (f.properties ? (f.properties[ID_KEY] ?? f.properties.LocalityID ?? f.properties.sublocationid) : undefined);
      const locName = (f.properties ? (f.properties[NAME_KEY] ?? f.properties.LocalityName ?? f.properties.sublocationname) : undefined) || `Locality ${locId}`;
      if (locId == null) return;

      if (selectedId != null && String(selectedId) === String(locId)) {
        setLocalitySelected(selectedId, false); selectedId = null;
        sel.loc = ''; if (ui.loc) ui.loc.value = '';
        sel.mm  = ''; if (ui.mm) ui.mm.value  = '';
        hideProjectsAll(); setSelectionFilters();
        ui.stats.textContent = 'Click a locality to see details here.';
        await applyChoropleth(); return;
      }

      if (selectedId != null) setLocalitySelected(selectedId, false);
      selectedId = locId; setLocalitySelected(locId, true);

      if (ui.loc) { ui.loc.value = String(locId); sel.loc = String(locId); }
      if (dims.localities?.length && ui.mm) {
        const match = dims.localities.find(l => String(l.id) === String(locId));
        if (match?.microMarketId != null) { ui.mm.value = String(match.microMarketId); sel.mm = String(match.microMarketId); }
      }

      if (map.getZoom() < 12) await fitToSelection();
      setSelectionFilters();

      const { month, asset, bhk } = getFilters();
      const summaryUrl = `${dataRoot}/summary/${encodeURIComponent(locId)}/${encodeURIComponent(month)}/${encodeURIComponent(asset)}/${encodeURIComponent(bhk)}.json`;
      try {
        const rsp = await fetch(summaryUrl); if (!rsp.ok) throw new Error(`HTTP ${rsp.status}`);
        const s = await rsp.json();
        ui.stats.innerHTML = `
          <div><b>${locName}</b></div>
          <div>Month: ${month}</div>
          <hr/>
          <div>Median Asking: ${fmtINR(s.median_asking)}</div>
          <div>Median Registered: ${fmtINR(s.median_registered)}</div>
          <div>Median Rent: ${fmtINR(s.median_rent)}</div>
          <div>Yield: ${fmtPct(s.yield)}</div>
          <div style="margin-top:6px; font-size:12px; color:${isDark ? '#cbd5e1' : '#475569'}">
            Samples — Asking: ${s.counts?.asking ?? '—'} • Registered: ${s.counts?.registered ?? '—'} • Rent: ${s.counts?.rent ?? '—'}
          </div>`;
      } catch { ui.stats.textContent = 'No summary for this selection.'; }

      if (cfg.sourceLayers.projects && map.getLayer('projects-point')) {
        if (ui.tProjects) { ui.tProjects.disabled = false; ui.tProjects.checked = true; }
        map.setLayoutProperty('projects-point','visibility','visible');
        map.setFilter('projects-point', projLocExpr(locId));
        animateProjectsForLocality(locId);

        if (ui.tDensity) ui.tDensity.disabled = false;
        await populateStatusesDropdownForLocality(locId);
        await updateCountsWidget(locId, ui.status.value);
      }
    }

    function onClickProject(e) {
      const feats = map.queryRenderedFeatures(e.point, { layers:['projects-point'] });
      if (!feats.length) return;
      const p = feats[0].properties || {};
      const pid = p.projectid ?? p.ProjectID;
      const name = p.ProjectName || p.projectname || `Project ${pid}`;
      const status = p.Status || p.projectstatus || '—';
      const [lng, lat] = feats[0].geometry?.coordinates || [];
      const { month, asset, bhk } = getFilters();
      fetch(`${dataRoot}/summary_project/${encodeURIComponent(pid)}/${encodeURIComponent(month)}/${encodeURIComponent(asset)}/${encodeURIComponent(bhk)}.json`)
        .then(r => r.ok ? r.json() : null)
        .then(s => {
          const card = ensureProjectCard();
          card.innerHTML = `
            <div style="font-weight:600; margin-bottom:6px;">${name}</div>
            <div style="font-size:13px; color:${isDark ? '#cbd5e1' : '#475569'}; margin-bottom:6px;">
              Status: ${status}${lat!=null && lng!=null ? ` • (${lat.toFixed(5)}, ${lng.toFixed(5)})` : ''}
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; font-size:14px;">
              <div><div style="color:#64748b;font-size:12px;">Asking</div><div>${fmtINR(s?.median_asking)}</div></div>
              <div><div style="color:#64748b;font-size:12px;">Registered</div><div>${fmtINR(s?.median_registered)}</div></div>
              <div><div style="color:#64748b;font-size:12px;">Rent</div><div>${fmtINR(s?.median_rent)}</div></div>
              <div><div style="color:#64748b;font-size:12px;">Yield</div><div>${fmtPct(s?.yield)}</div></div>
            </div>`;
        }).catch(()=>{});
    }

    map.on('click','localities-fill', onClickLocality);
    if (cfg.sourceLayers.projects) map.on('click','projects-point', onClickProject);

    map.on('click', async (e) => {
      const onLoc  = map.queryRenderedFeatures(e.point, { layers:['localities-fill'] }).length > 0;
      const onProj = cfg.sourceLayers.projects &&
                     map.queryRenderedFeatures(e.point, { layers:['projects-point'] }).length > 0;
      if (!onLoc && !onProj && selectedId != null) {
        setLocalitySelected(selectedId, false); selectedId = null;
        sel.loc = ''; if (ui.loc) ui.loc.value = '';
        sel.mm  = ''; if (ui.mm) ui.mm.value  = '';
        hideProjectsAll(); setSelectionFilters();
        ui.stats.textContent = 'Click a locality to see details here.';
        await applyChoropleth();
      }
    });
    window.addEventListener('keydown', ev => { if (ev.key === 'Escape') map.fire('click', { point:{x:-1,y:-1}, lngLat: map.getCenter() }); });

    // ---- Toggles ----
    ui.tMM?.addEventListener('change', e => {
      const v = e.target.checked ? 'visible' : 'none';
      ['mm-outline-casing','mm-outline','mm-labels'].forEach(id => map.getLayer(id)&&map.setLayoutProperty(id,'visibility',v));
    });
    ui.tRoads?.addEventListener('change', e => {
      const v = e.target.checked ? 'visible' : 'none';
      ['roads-line-casing','roads-line'].forEach(id => map.getLayer(id)&&map.setLayoutProperty(id,'visibility',v));
    });
    ui.tProjects?.addEventListener('change', async (e) => {
      const v = e.target.checked ? 'visible' : 'none';
      if (map.getLayer('projects-point')) map.setLayoutProperty('projects-point','visibility', v);
      if (!e.target.checked && map.getLayer('projects-point')) map.setFilter('projects-point', null);
      if (!e.target.checked && projectHoverPopup) { projectHoverPopup.remove(); projectHoverPopup = null; }
      if (sel.loc) {
        const statusSel = ui.tDensity?.checked ? ui.status.value : STATUS_ALL;
        await updateCountsWidget(sel.loc, statusSel);
      }
    });

    ui.tDensity?.addEventListener('change', async (e) => {
      if (!sel.loc) { e.target.checked = false; return; }
      const on = e.target.checked;
      if (ui.status) ui.status.disabled = !on;
      if (!map.getLayer('projects-heat')) return;
      if (on) {
        const statusSel = ui.status?.value || STATUS_ALL;
        map.setFilter('projects-heat', ['all', projLocExpr(sel.loc), projStatusExpr(statusSel)]);
        map.setPaintProperty('projects-heat','heatmap-color', heatmapColorsForStatus(statusSel));
        map.setLayoutProperty('projects-heat','visibility','visible');
        await updateCountsWidget(sel.loc, statusSel);
      } else {
        map.setLayoutProperty('projects-heat','visibility','none');
        map.setFilter('projects-heat', null);
        await updateCountsWidget(sel.loc, STATUS_ALL);
      }
    });

    ui.status?.addEventListener('change', async () => {
      if (!sel.loc || !ui.tDensity?.checked) return;
      const statusSel = ui.status.value || STATUS_ALL;
      if (map.getLayer('projects-heat')) {
        map.setFilter('projects-heat', ['all', projLocExpr(sel.loc), projStatusExpr(statusSel)]);
        map.setPaintProperty('projects-heat','heatmap-color', heatmapColorsForStatus(statusSel));
      }
      await updateCountsWidget(sel.loc, statusSel);
    });

    function applyTheme(preset) {
      const valid = (preset === 'night') ? 'night' : 'day';
      const scheme = (valid === 'night') ? 'dark' : 'light';
      if (map.setConfig) { try { map.setConfig({ lightPreset: valid, colorScheme: scheme }); } catch(e){} }
      isDark = (valid === 'night');
      map.setPaintProperty('localities-labels','text-color', isDark ? '#e5e7eb' : '#111827');
      map.setPaintProperty('localities-outline','line-color', isDark ? '#9ca3af' : '#7c7c7c');
      if (map.getLayer('mm-outline-casing')) map.setPaintProperty('mm-outline-casing','line-color', isDark ? CASING_COLOR_DARK : CASING_COLOR_LIGHT);
      if (map.getLayer('mm-outline')) {
        map.setPaintProperty('mm-outline','line-color', isDark ? OUTLINE_COLORS.dark.mm : OUTLINE_COLORS.light.mm);
        map.setPaintProperty('mm-outline','line-dasharray',['literal',[0.1,1.2]]);
      }
      if (map.getLayer('roads-line-casing')) map.setPaintProperty('roads-line-casing','line-color', isDark ? CASING_COLOR_DARK : CASING_COLOR_LIGHT);
      if (map.getLayer('roads-line')) {
        map.setPaintProperty('roads-line','line-color', isDark ? OUTLINE_COLORS.dark.roads : OUTLINE_COLORS.light.roads);
        map.setPaintProperty('roads-line','line-dasharray',['literal',[0.1,1.2]]);
      }
      ui.apply.click();
    }
    ui.theme?.addEventListener('change', () => applyTheme(ui.theme.value));

    ui.apply.addEventListener('click', applyChoropleth);
    await applyChoropleth();
  });

  // Debug helper
  window._sqy = {
    cfg, dims, map, sel,
    pingChoropleth: () => {
      const { metric, month, asset, bhk } = getFilters();
      const u = `\n${cfg.dataRoot}/choropleth/${encodeURIComponent(metric)}/${encodeURIComponent(month)}/${encodeURIComponent(asset)}/${encodeURIComponent(bhk)}.json`;
      console.log('[debug choropleth URL]', u);
      return fetch(u).then(r => (console.log('status', r.status), r.ok ? r.json() : null)).then(d => (console.log('sample', d?.slice?.(0, 5)), d));
    }
  };
})();