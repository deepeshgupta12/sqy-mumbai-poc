/* SquareYards – Mumbai POC (stable choropleth + click UX + projects animation + project hover card)
   Fixes kept:
   - line-dasharray uses ['literal', [a,b]] (avoids v3 evaluate error)
   - choropleth guard: ['number',['feature-state','value'],-9999] + neutral band
   - re-apply choropleth on deselect to hydrate newly loaded tiles
*/

(async function () {
  const cfg  = await fetch('./config.json').then(r => r.json());
  const dims = await fetch('./dims.json').then(r => (r.ok ? r.json() : ({
    bhk: [], assets: [], city: null, micromarkets: [], localities: []
  })));

  mapboxgl.accessToken = (cfg.mapboxToken || '').toString().replace(/[\s\u00A0]/g, '');
  const dataRoot = cfg.dataRoot.startsWith('/')
    ? cfg.dataRoot
    : '/' + cfg.dataRoot.replace(/^\.\//, '').replace(/^\.\.\//, '');

  const center = dims.city?.center || [72.8777, 19.0760];
  const zoom   = dims.city?.zoom   || 10;

  const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/standard',
    center, zoom, pitch: 0, bearing: 0, antialias: true
  });
  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.on('error', (e) => {
    const msg = String(e?.error?.message || '');
    if (msg.includes('Unauthorized') || msg.includes('NetworkError') || msg.includes('Style')) {
      console.error('[mapbox error]', e.error);
    }
  });

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
    tProjects: document.getElementById('toggle-projects')
  };

  if (dims.assets?.length) ui.asset.innerHTML = dims.assets.map(a => `<option value="${a.code}">${a.label || a.code}</option>`).join('');
  if (dims.bhk?.length)    ui.bhk.innerHTML   = dims.bhk.map(b => `<option value="${b.code}">${b.label || b.code}</option>`).join('');
  if (dims.micromarkets?.length && ui.mm)
    ui.mm.innerHTML = '<option value="">All Micromarkets</option>' + dims.micromarkets.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  if (dims.localities?.length && ui.loc)
    ui.loc.innerHTML = '<option value="">All Localities</option>' + dims.localities.map(l => `<option value="${l.id}">${l.name}</option>`).join('');

  if (cfg.default) {
    if (cfg.default.metric) ui.metric.value = cfg.default.metric;
    if (cfg.default.month)  ui.month.value  = cfg.default.month;
    if (cfg.default.asset)  ui.asset.value  = cfg.default.asset;
    if (cfg.default.bhk)    ui.bhk.value    = cfg.default.bhk;
  }
  if (ui.theme) ui.theme.value = 'day';
  if (ui.tProjects) { ui.tProjects.checked = false; ui.tProjects.disabled = true; }

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
    // Guard: neutral band at -9999 makes “no value” draw grey, without null warnings.
    const neutral = isDark ? '#374151' : '#d1d5db';
    const colors  = isDark ? PALETTE_DARK : PALETTE_LIGHT;

    const expr = ['interpolate', ['linear'], ['number', ['feature-state','value'], -9999],
                  -9999, neutral];
    for (let i = 0; i < stops.length; i++) {
      expr.push(stops[i], colors[Math.min(i, colors.length - 1)]);
    }
    return expr;
  }

  function renderLegend(stops, isDark, formatter) {
    const colors = isDark ? PALETTE_DARK : PALETTE_LIGHT;
    ui.legend.innerHTML = '';
    // skip the neutral (-9999) band; only render quantiles
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

  const sel = { mm: '', loc: '' };
  let featureIdType = 'number';
  let ID_KEY   = 'LocalityID';
  let NAME_KEY = 'LocalityName';
  let selectedId = null;
  let isDark = false;

  const castId = id => (featureIdType === 'number' ? Number(id) : String(id));
  const projLocExpr = (idStr) => ['==', ['to-string', ['coalesce', ['get','LocalityID'], ['get','sublocationid']]], String(idStr)];

  map.on('load', async () => {
    if (map.setConfig) map.setConfig({ lightPreset: 'day', colorScheme: 'light', show3dBuildings: true });
    isDark = false;

    try {
      map.addSource('mapbox-dem', { type:'raster-dem', url:'mapbox://mapbox.mapbox-terrain-dem-v1', tileSize:512, maxzoom:14 });
      map.setTerrain({ source:'mapbox-dem', exaggeration:1.0 });
      map.addLayer({ id:'sky', type:'sky', paint:{ 'sky-type':'atmosphere', 'sky-atmosphere-sun':[0.0,90.0], 'sky-atmosphere-sun-intensity':15 }});
    } catch {}

    map.easeTo({ pitch: 60, bearing: 20, duration: 1000 });

    map.addSource('localities',   { type:'vector', url: cfg.tilesets.localities });
    if (cfg.tilesets.micromarkets) map.addSource('micromarkets', { type:'vector', url: cfg.tilesets.micromarkets });
    if (cfg.tilesets.roads)        map.addSource('roads',        { type:'vector', url: cfg.tilesets.roads });
    if (cfg.tilesets.projects)     map.addSource('projects',     { type:'vector', url: cfg.tilesets.projects });

    map.addLayer({
      id:'localities-fill', type:'fill', source:'localities', 'source-layer': cfg.sourceLayers.localities,
      paint:{ 'fill-color':'#d1d5db', 'fill-opacity':['case',['boolean',['feature-state','selected'],false],0.95,0.75] }
    });
    map.addLayer({
      id:'localities-outline', type:'line', source:'localities', 'source-layer': cfg.sourceLayers.localities,
      paint:{ 'line-color':['case',['boolean',['feature-state','selected'],false],'#111827','#7c7c7c'], 'line-width':['case',['boolean',['feature-state','selected'],false],1.8,0.8] }
    });
    map.addLayer({
      id:'localities-labels', type:'symbol', source:'localities', 'source-layer': cfg.sourceLayers.localities, minzoom:11.2,
      layout:{ 'text-field':['coalesce',['get','LocalityName'],['get','sublocationname']], 'text-size':11, 'text-variable-anchor':['top','bottom','left','right'], 'text-justify':'auto', 'text-padding':2 },
      paint:{ 'text-color':'#111827', 'text-halo-color':'#ffffff', 'text-halo-width':1 }
    });

    if (cfg.sourceLayers.micromarkets) {
      map.addLayer({
        id:'mm-outline-casing', type:'line', source:'micromarkets', 'source-layer': cfg.sourceLayers.micromarkets,
        layout:{ 'line-cap':'round','line-join':'round' },
        paint:{ 'line-color': CASING_COLOR_LIGHT, 'line-width':['interpolate',['linear'],['zoom'],9,2.2,12,3.2,14,4.4], 'line-opacity':0.9, 'line-blur':0.2 }
      });
      map.addLayer({
        id:'mm-outline', type:'line', source:'micromarkets', 'source-layer': cfg.sourceLayers.micromarkets,
        layout:{ 'line-cap':'round','line-join':'round' },
        paint:{ 'line-color': OUTLINE_COLORS.light.mm, 'line-width':['interpolate',['linear'],['zoom'],9,1.4,12,2.4,14,3.4], 'line-opacity':0.95, 'line-dasharray': DOT_DASH_LITERAL }
      });
      map.addLayer({
        id:'mm-labels', type:'symbol', source:'micromarkets', 'source-layer': cfg.sourceLayers.micromarkets, maxzoom:11.2,
        layout:{ 'text-field':['coalesce',['get','MicroMarketName'],['get','locationname']], 'text-size':13 },
        paint:{ 'text-color':'#374151','text-halo-color':'#fff','text-halo-width':1 }
      });
    }

    if (cfg.sourceLayers.roads) {
      map.addLayer({
        id:'roads-line-casing', type:'line', source:'roads', 'source-layer': cfg.sourceLayers.roads,
        layout:{ 'line-cap':'round','line-join':'round' },
        paint:{ 'line-color': CASING_COLOR_LIGHT, 'line-width':['interpolate',['linear'],['zoom'],10,2.0,12,3.0,14,4.2,16,5.2], 'line-opacity':0.9, 'line-blur':0.15 }
      });
      map.addLayer({
        id:'roads-line', type:'line', source:'roads', 'source-layer': cfg.sourceLayers.roads,
        layout:{ 'line-cap':'round','line-join':'round' },
        paint:{ 'line-color': OUTLINE_COLORS.light.roads, 'line-width':['interpolate',['linear'],['zoom'],10,1.2,12,2.0,14,3.2,16,4.2], 'line-opacity':0.95, 'line-dasharray': DOT_DASH_LITERAL }
      });
    }

    if (cfg.sourceLayers.projects) {
      map.addLayer({
        id:'projects-point', type:'circle', source:'projects', 'source-layer': cfg.sourceLayers.projects,
        paint:{
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 6, 16, 10],
          'circle-color': ['match', ['get','Status'], 'Ready to Move','#16a34a', 'Under Construction','#f59e0b', /*other*/ '#3b82f6'],
          'circle-stroke-color':'#ffffff', 'circle-stroke-width':0.8, 'circle-opacity':0.95
        },
        layout:{ 'visibility':'none' }
      });

      /* ---------- Project hover popup (image + name + status + lat/lng) ---------- */
      let projectHoverPopup = null;
      let lastProjectHoverId = null;

      function buildProjectHoverHTML(f) {
        const p = f.properties || {};
        const name   = p.ProjectName || p.projectname || 'Project';
        const status = p.Status || p.projectstatus || '—';

        let lon = null, lat = null;
        if (f.geometry && f.geometry.type === 'Point' && Array.isArray(f.geometry.coordinates)) {
          lon = Number(f.geometry.coordinates[0]);
          lat = Number(f.geometry.coordinates[1]);
        }
        const latTxt = (lat != null && isFinite(lat)) ? lat.toFixed(6) : '—';
        const lonTxt = (lon != null && isFinite(lon)) ? lon.toFixed(6) : '—';

        // Use a JPG/PNG placeholder (avoid SVGs for WebGL contexts)
        const imgURL = './assets/img/project-placeholder.jpg';

        return `
          <div style="width:260px">
            <div style="font-weight:600;margin-bottom:6px">${name}</div>
            <img src="${imgURL}" alt="project" style="width:100%;height:auto;border-radius:6px;margin-bottom:6px"/>
            <div style="font-size:12px;color:#374151"><b>Status:</b> ${status}</div>
            <div style="font-size:12px;color:#374151"><b>Lat:</b> ${latTxt} &nbsp; <b>Lng:</b> ${lonTxt}</div>
          </div>
        `;
      }

      map.on('mouseenter', 'projects-point', () => {
        map.getCanvas().style.cursor = 'pointer';
      });

      map.on('mouseleave', 'projects-point', () => {
        map.getCanvas().style.cursor = '';
        if (projectHoverPopup) { projectHoverPopup.remove(); projectHoverPopup = null; }
        lastProjectHoverId = null;
      });

      map.on('mousemove', 'projects-point', (e) => {
        if (!e.features || !e.features.length) return;
        const f = e.features[0];
        if (!f) return;

        // If still on same feature, just move popup
        if (lastProjectHoverId === f.id) {
          if (projectHoverPopup) projectHoverPopup.setLngLat(e.lngLat);
          return;
        }
        lastProjectHoverId = f.id;

        const html = buildProjectHoverHTML(f);

        let lngLat = e.lngLat;
        if (f.geometry && f.geometry.type === 'Point' && Array.isArray(f.geometry.coordinates)) {
          lngLat = { lng: Number(f.geometry.coordinates[0]), lat: Number(f.geometry.coordinates[1]) };
        }

        if (projectHoverPopup) projectHoverPopup.remove();
        projectHoverPopup = new mapboxgl.Popup({
            closeButton: false,
            closeOnClick: false,
            offset: [0, 10],
            maxWidth: '280px'
          })
          .setLngLat(lngLat)
          .setHTML(html)
          .addTo(map);
      });
      /* -------------------------------------------------------------------------- */
    }

    try {
      const sample = map.querySourceFeatures('localities', { sourceLayer: cfg.sourceLayers.localities })[0];
      if (sample) {
        featureIdType = typeof sample.id;
        const p = sample.properties || {};
        if ('LocalityID' in p || 'LocalityName' in p) { ID_KEY='LocalityID'; NAME_KEY='LocalityName'; }
        else if ('sublocationid' in p || 'sublocationname' in p) { ID_KEY='sublocationid'; NAME_KEY='sublocationname'; }
        console.log('[detect]', { featureIdType, ID_KEY, NAME_KEY });
      }
    } catch {}

    async function applyChoropleth() {
      const metric = ui.metric.value, month = ui.month.value, asset = ui.asset.value, bhk = ui.bhk.value;
      const url = `${dataRoot}/choropleth/${metric}/${month}/${asset}/${bhk}.json`;
      let arr = [];
      try {
        const rsp = await fetch(url);
        if (!rsp.ok) throw new Error(`HTTP ${rsp.status}`);
        arr = await rsp.json();
      } catch (e) {
        console.warn('Choropleth fetch failed:', e);
        ui.legend.innerHTML = '(no data)';
        map.setPaintProperty('localities-fill', 'fill-color', isDark ? '#374151' : '#d1d5db');
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

      map.setPaintProperty('localities-fill', 'fill-color', paintExpression(stops, isDark));
      map.setPaintProperty('localities-outline', 'line-color', isDark ? '#9ca3af' : '#7c7c7c');
      map.setPaintProperty('localities-labels', 'text-color', isDark ? '#e5e7eb' : '#111827');
    }

    function setSelectionFilters() {
      if (sel.loc) {
        const id = castId(sel.loc);
        const filter = ['==', ['id'], id];
        map.setFilter('localities-fill',    filter);
        map.setFilter('localities-outline', filter);
        map.setFilter('localities-labels',  filter);
      } else if (sel.mm) {
        const ids = (dims.localities || []).filter(l => String(l.microMarketId ?? '') === String(sel.mm)).map(l => castId(l.id));
        const filter = ids.length ? ['in', ['id'], ...ids] : null;
        map.setFilter('localities-fill',    filter);
        map.setFilter('localities-outline', filter);
        map.setFilter('localities-labels',  filter);
      } else {
        map.setFilter('localities-fill',    null);
        map.setFilter('localities-outline', null);
        map.setFilter('localities-labels',  null);
      }

      if (cfg.sourceLayers.projects) {
        if (sel.loc) {
          if (ui.tProjects) { ui.tProjects.disabled = false; ui.tProjects.checked = true; }
          if (map.getLayer('projects-point')) {
            map.setLayoutProperty('projects-point', 'visibility', 'visible');
            map.setFilter('projects-point', projLocExpr(sel.loc));
          }
        } else if (sel.mm) {
          if (ui.tProjects?.checked && map.getLayer('projects-point')) {
            const f = ['any',
              ['==', ['coalesce', ['to-string',['get','MicroMarketID']], '' ], String(sel.mm)],
              ['==', ['coalesce', ['to-string',['get','locationid']],    '' ], String(sel.mm)]
            ];
            map.setFilter('projects-point', f);
          }
        } else {
          if (map.getLayer('projects-point')) {
            const vis = (ui.tProjects && ui.tProjects.checked) ? 'visible' : 'none';
            map.setLayoutProperty('projects-point', 'visibility', vis);
            if (!ui.tProjects?.checked) map.setFilter('projects-point', null);
          }
        }
      }
    }

    async function fitToSelection() {
      const feats = map.queryRenderedFeatures({ layers: ['localities-fill'] });
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

    ui.mm?.addEventListener('change', async () => {
      sel.mm = ui.mm.value || ''; sel.loc = ''; if (ui.loc) ui.loc.value = '';
      setSelectionFilters(); await fitToSelection();
      ui.stats.textContent = 'Click a locality to see details here.'; clearProjectCard();
      await applyChoropleth(); // refresh visible tiles’ states
    });
    ui.loc?.addEventListener('change', async () => {
      sel.loc = ui.loc.value || '';
      setSelectionFilters(); await fitToSelection();
      await applyChoropleth();
    });

    function setLocalitySelected(id, on) {
      const layerName = cfg.sourceLayers.localities;
      map.setFeatureState({ source:'localities', sourceLayer: layerName, id: castId(id) }, { selected: !!on });
    }

    function animateProjectsForLocality(locId) {
      if (!cfg.sourceLayers.projects || !map.getLayer('projects-point')) return;
      const start = performance.now();
      const base = ['interpolate',['linear'],['zoom'], 10, 2, 14, 6, 16, 10];
      const cond = projLocExpr(locId);
      function frame(ts) {
        const t = Math.min(1, (ts - start) / 450);
        const bump = 1 + 0.35 * (1 - Math.cos(Math.PI * t));
        const expr = ['interpolate',['linear'],['zoom'],
          10, ['case', cond, 2 * bump, 2],
          14, ['case', cond, 6 * bump, 6],
          16, ['case', cond,10 * bump,10]
        ];
        map.setPaintProperty('projects-point', 'circle-radius', expr);
        if (t < 1) requestAnimationFrame(frame); else map.setPaintProperty('projects-point','circle-radius', base);
      }
      requestAnimationFrame(frame);
    }

    function ensureProjectCard() {
      let card = document.getElementById('proj-card');
      if (!card) {
        card = document.createElement('div');
        card.id = 'proj-card';
        card.style.marginTop = '10px';
        card.style.borderTop = '1px solid #e5e7eb';
        card.style.paddingTop = '10px';
        ui.stats.appendChild(card);
      }
      return card;
    }
    function clearProjectCard() { const el = document.getElementById('proj-card'); if (el) el.remove(); }

    async function onClickLocality(e) {
      const feats = map.queryRenderedFeatures(e.point, { layers: ['localities-fill'] });
      if (!feats.length) return;
      const f = feats[0];

      const locId = (f.id != null ? f.id : undefined) ??
        (f.properties ? (f.properties[ID_KEY] ?? f.properties.LocalityID ?? f.properties.sublocationid) : undefined);
      const locName = (f.properties ? (f.properties[NAME_KEY] ?? f.properties.LocalityName ?? f.properties.sublocationname) : undefined)
        || `Locality ${locId}`;
      if (locId == null) return;

      // toggle deselect if clicking the same again
      if (selectedId != null && String(selectedId) === String(locId)) {
        setLocalitySelected(selectedId, false);
        selectedId = null; sel.loc = ''; if (ui.loc) ui.loc.value = '';
        setSelectionFilters();
        ui.stats.textContent = 'Click a locality to see details here.'; clearProjectCard();
        await applyChoropleth(); // <- restore visible tile states
        return;
      }

      if (selectedId != null) setLocalitySelected(selectedId, false);
      selectedId = locId;
      setLocalitySelected(locId, true);

      if (ui.loc) { ui.loc.value = String(locId); sel.loc = String(locId); }
      if (dims.localities?.length && ui.mm) {
        const match = dims.localities.find(l => String(l.id) === String(locId));
        if (match?.microMarketId != null) { ui.mm.value = String(match.microMarketId); sel.mm = String(match.microMarketId); }
      }

      if (map.getZoom() < 12) await fitToSelection();
      setSelectionFilters();

      const metric = ui.metric.value, month = ui.month.value, asset = ui.asset.value, bhk = ui.bhk.value;
      const summaryUrl = `${dataRoot}/summary/${locId}/${month}/${asset}/${bhk}.json`;
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
        map.setLayoutProperty('projects-point', 'visibility', 'visible');
        map.setFilter('projects-point', projLocExpr(locId));
        animateProjectsForLocality(locId);
      }
    }

    function onClickProject(e) {
      const feats = map.queryRenderedFeatures(e.point, { layers: ['projects-point'] });
      if (!feats.length) return;
      const p = feats[0].properties || {};
      const pid = p.projectid ?? p.ProjectID;
      const name = p.ProjectName || p.projectname || `Project ${pid}`;
      const status = p.Status || p.projectstatus || '—';
      const [lng, lat] = feats[0].geometry?.coordinates || [];

      fetch(`${dataRoot}/summary_project/${pid}/${ui.month.value}/${ui.asset.value}/${ui.bhk.value}.json`)
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
        })
        .catch(()=>{ /* ignore */ });
    }

    map.on('click', 'localities-fill', onClickLocality);
    if (cfg.sourceLayers.projects) map.on('click', 'projects-point', onClickProject);

    map.on('click', (e) => {
      const onLoc  = map.queryRenderedFeatures(e.point, { layers:['localities-fill'] }).length > 0;
      const onProj = cfg.sourceLayers.projects && map.queryRenderedFeatures(e.point, { layers:['projects-point'] }).length > 0;
      if (!onLoc && !onProj && selectedId != null) {
        setLocalitySelected(selectedId, false);
        selectedId = null; sel.loc = ''; if (ui.loc) ui.loc.value = '';
        setSelectionFilters(); ui.stats.textContent = 'Click a locality to see details here.'; clearProjectCard();
        ui.apply.click(); // re-hydrate any tiles we just revealed
      }
    });
    window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { map.fire('click', { point:{x:-1,y:-1}, lngLat: map.getCenter() }); } });

    ui.tMM?.addEventListener('change', e => {
      const v = e.target.checked ? 'visible' : 'none';
      ['mm-outline-casing','mm-outline','mm-labels'].forEach(id => map.getLayer(id)&&map.setLayoutProperty(id,'visibility',v));
    });
    ui.tRoads?.addEventListener('change', e => {
      const v = e.target.checked ? 'visible' : 'none';
      ['roads-line-casing','roads-line'].forEach(id => map.getLayer(id)&&map.setLayoutProperty(id,'visibility',v));
    });
    ui.tProjects?.addEventListener('change', e => {
      const v = e.target.checked ? 'visible' : 'none';
      if (map.getLayer('projects-point')) map.setLayoutProperty('projects-point', 'visibility', v);
      if (!e.target.checked && map.getLayer('projects-point')) map.setFilter('projects-point', null);
      if (!e.target.checked) { /* also hide hover if open */ }
    });

    ui.apply.addEventListener('click', applyChoropleth);
    await applyChoropleth();
  });

  window._sqy = {
    cfg, dims, map, sel,
    pingChoropleth: () => {
      const u = `\n${cfg.dataRoot}/choropleth/${document.getElementById('metric').value}/${document.getElementById('month').value}/${document.getElementById('asset').value}/${document.getElementById('bhk').value}.json`;
      console.log('[debug choropleth URL]', u);
      return fetch(u).then(r => (console.log('status', r.status), r.ok ? r.json() : null)).then(d => (console.log('sample', d?.slice?.(0, 5)), d));
    }
  };
})();