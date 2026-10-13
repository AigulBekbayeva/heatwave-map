/* Global Heatwave Map — front end (D3 v7, no build step). */
(() => {
  "use strict";

  const REPO_URL = document.querySelector('meta[name="repo-url"]')?.content
    || guessRepoUrl();

  // ---- colour ---------------------------------------------------------------
  // Heatwave days: thresholded sequential ramp (dark → bright, perceptually ordered).
  const DAY_BREAKS = [1, 5, 10, 15, 20, 30, 45, 60];
  const DAY_COLORS = ["#2b2622", ...d3.quantize(t => d3.interpolateInferno(0.22 + 0.74 * t), DAY_BREAKS.length)];
  // Change vs 2000–09: diverging, blue = fewer, red/orange = more, grey midpoint.
  const CHG_BREAKS = [-10, -5, -2, 2, 5, 10, 20];
  const CHG_COLORS = ["#9ec5f4", "#5598e7", "#2f5486", "#3b3835", "#7a3528", "#c2452f", "#f06a3a", "#ffb27a"];
  const NODATA = "url(#nodata)";

  const dayColor = d3.scaleThreshold(DAY_BREAKS, DAY_COLORS);
  const chgColor = d3.scaleThreshold(CHG_BREAKS, CHG_COLORS);

  const fmt1 = d3.format(".1f");
  const fmt0 = d3.format(".0f");
  const fmtSigned = v => (v > 0 ? "+" : v < 0 ? "−" : "±") + fmt0(Math.abs(v));
  const fmtDays = v => (Math.abs(v - Math.round(v)) < 0.05 ? fmt0(v) : fmt1(v));

  // ---- state ----------------------------------------------------------------
  const state = { mode: "days", year: null, selected: null, playing: false, timer: null };
  let geo, meta, data, years, partial, lastFull, globalSeries, projection, path;

  const $ = s => document.querySelector(s);
  const tip = $("#tip");

  Promise.all([d3.json("data/countries.geojson"), d3.json("data/heatwaves.json")])
    .then(([g, hw]) => init(g, hw))
    .catch(err => {
      $("#headline").textContent = "Data is not available yet — the first download runs after the repository is set up.";
      console.error(err);
    });

  function init(g, hw) {
    geo = g; meta = hw.meta; data = hw.countries;
    years = d3.range(meta.first_year, meta.last_year + 1);
    partial = meta.data_through && meta.data_through < `${meta.last_year}-12-31`;
    lastFull = partial ? meta.last_year - 1 : meta.last_year;
    state.year = Math.max(meta.first_year, lastFull);

    globalSeries = years.map((y, i) => {
      const v = Object.values(data).map(c => c.days[i]).filter(v => v != null);
      return v.length ? d3.mean(v) : null;
    });

    const slider = $("#year");
    slider.min = meta.first_year; slider.max = meta.last_year; slider.value = state.year;
    slider.addEventListener("input", () => { stop(); setYear(+slider.value); });
    $("#play").addEventListener("click", () => (state.playing ? stop() : play()));
    document.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
    $("#clearSel").addEventListener("click", () => select(null));
    $("#download").addEventListener("click", exportPng);
    $("#repoLink").href = REPO_URL;
    $("#through").textContent = meta.data_through || "—";
    $("#partialNote").hidden = !partial;
    $("#generated").textContent = `Updated ${meta.generated_at.replace("T", " ")} UTC · data through ${meta.data_through}`;

    if (meta.countries_done < meta.countries_total) {
      const pct = (100 * meta.countries_done / meta.countries_total).toFixed(0);
      const b = $("#progress");
      b.hidden = false;
      b.innerHTML = `<strong>Download in progress:</strong> ${meta.countries_done} of ${meta.countries_total} countries processed so far. ` +
        `Hatched countries fill in as the daily update downloads their 27-year ERA5 history.<div class="bar"><span style="width:${pct}%"></span></div>`;
    }

    drawMap();
    window.addEventListener("resize", debounce(() => { drawSeries(); }, 150));
    render();
  }

  // ---- values ---------------------------------------------------------------
  const yi = y => y - meta.first_year;
  function valueOf(iso) {
    const c = data[iso];
    if (!c) return null;
    if (state.mode === "change") return c.change;
    return c.days[yi(state.year)];
  }
  const colorOf = v => (v == null ? NODATA : state.mode === "change" ? chgColor(v) : dayColor(v));
  const yearLabel = y => (partial && y === meta.last_year ? `${y} to date` : `${y}`);

  // ---- map ------------------------------------------------------------------
  function drawMap() {
    const W = 960, H = 470;
    const svg = d3.select("#map").attr("viewBox", `0 0 ${W} ${H}`);
    const defs = svg.append("defs");
    const pat = defs.append("pattern").attr("id", "nodata").attr("width", 6).attr("height", 6)
      .attr("patternUnits", "userSpaceOnUse").attr("patternTransform", "rotate(45)");
    pat.append("rect").attr("width", 6).attr("height", 6).attr("fill", "#1c1a17");
    pat.append("rect").attr("width", 3).attr("height", 6).attr("fill", "#2a2622");

    projection = d3.geoEqualEarth().fitExtent([[8, 8], [W - 8, H - 8]], { type: "Sphere" });
    path = d3.geoPath(projection);
    svg.append("path").attr("class", "sphere").attr("d", path({ type: "Sphere" }));
    svg.append("path").attr("class", "graticule").attr("d", path(d3.geoGraticule10()));

    svg.append("g").selectAll("path").data(geo.features).join("path")
      .attr("class", "country")
      .attr("d", path)
      .on("pointerenter pointermove", (ev, f) => showTip(ev, f.properties.iso, f.properties.name))
      .on("pointerleave", hideTip)
      .on("click", (ev, f) => select(state.selected === f.properties.iso ? null : f.properties.iso));
  }

  function render() {
    d3.selectAll("#map .country")
      .attr("fill", f => colorOf(valueOf(f.properties.iso)))
      .classed("selected", f => f.properties.iso === state.selected);
    $("#yearLabel").innerHTML = state.mode === "change"
      ? `2016–25<small>vs 2000–09</small>`
      : partial && state.year === meta.last_year ? `${state.year}<small>TO DATE</small>` : `${state.year}`;
    $("#timeline").classList.toggle("disabled", state.mode === "change");
    drawLegend();
    drawHeadline();
    drawSeries();
    drawTop();
    drawTable();
  }

  function setYear(y) {
    state.year = y;
    $("#year").value = y;
    render();
  }
  function setMode(m) {
    stop();
    state.mode = m;
    document.querySelectorAll(".seg button").forEach(b => b.setAttribute("aria-selected", b.dataset.mode === m));
    render();
  }
  function select(iso) {
    state.selected = iso && data[iso] ? iso : null;
    render();
  }
  function play() {
    if (state.mode !== "days") setMode("days");
    state.playing = true;
    $("#playIcon").setAttribute("d", "M4 2.5h3v11H4zM9 2.5h3v11H9z");
    $("#play").setAttribute("aria-label", "Pause animation");
    if (state.year >= meta.last_year) setYear(meta.first_year);
    state.timer = d3.interval(() => {
      if (state.year >= meta.last_year) return stop();
      setYear(state.year + 1);
    }, 750);
  }
  function stop() {
    state.playing = false;
    if (state.timer) state.timer.stop();
    state.timer = null;
    $("#playIcon").setAttribute("d", "M4 2.5v11l9-5.5z");
    $("#play").setAttribute("aria-label", "Play animation");
  }

  // ---- legend & headline ----------------------------------------------------
  function drawLegend() {
    const isChg = state.mode === "change";
    const colors = isChg ? CHG_COLORS : DAY_COLORS;
    const labels = isChg
      ? ["", ...CHG_BREAKS.map(fmtSigned)]
      : ["0", ...DAY_BREAKS.map(b => fmt0(b))];
    const title = isChg
      ? "Change in heatwave days per year, 2016–2025 average minus 2000–2009 average"
      : `Heatwave days in ${yearLabel(state.year)}`;
    $("#legend").innerHTML =
      `<div class="title">${title}</div>` +
      `<div class="ramp">${colors.map((c, i) => `<div><i style="background:${c}"></i><span>${labels[i]}${!isChg && i === colors.length - 1 ? "+" : ""}</span></div>`).join("")}</div>` +
      `<div class="ramp nodata"><div><i></i><span>pending</span></div></div>`;
  }

  function drawHeadline() {
    const h = $("#headline");
    const n = Object.keys(data).length;
    if (!n) { h.textContent = "No countries processed yet — the first daily download is under way."; return; }
    const early = d3.mean(globalSeries.slice(0, 10));
    if (state.mode === "change") {
      const ch = Object.values(data).map(c => c.change).filter(v => v != null);
      const up = ch.filter(v => v > 0).length;
      h.innerHTML = `<b>${up} of ${ch.length}</b> countries now get more heatwave days than in the early 2000s — ` +
        `on average <span class="hot">${fmtSigned(d3.mean(ch))} days a year</span>.`;
      return;
    }
    const v = globalSeries[yi(state.year)];
    const ratio = early > 0 ? v / early : null;
    const cmp = ratio == null ? "" : ratio >= 1.15
      ? ` — <span class="hot">${fmt1(ratio)}×</span> the 2000–2009 average of ${fmtDays(early)}`
      : ratio <= 0.87 ? ` — below the 2000–2009 average of ${fmtDays(early)}` : ` — close to the 2000–2009 average of ${fmtDays(early)}`;
    const when = partial && state.year === meta.last_year ? `So far in ${state.year}` : `In ${state.year}`;
    h.innerHTML = `${when}, the average country had <b>${fmtDays(v)} heatwave days</b>${cmp}.`;
  }

  // ---- year series (selected country or global average) ---------------------
  function drawSeries() {
    const sel = state.selected && data[state.selected];
    const series = sel ? sel.days : globalSeries;
    $("#seriesTitle").textContent = sel ? sel.name : "Average across countries";
    $("#seriesSub").textContent = sel
      ? `Heatwave days per year at ${sel.points.map(p => p.place).join(", ")}. Hot-day threshold in peak season ≈ ${sel.points[0].peak_threshold_c}°C.`
      : `Heatwave days per year, mean of ${Object.keys(data).length} countries. Click a country on the map.`;
    $("#seriesNote").textContent = !series.some(v => v != null) ? "" : `Dashed line: 2000–09 average (${fmtDays(d3.mean(series.slice(0, 10)))} days)` +
      (partial ? ` · ${meta.last_year} is year to date` : "");
    $("#clearSel").hidden = !sel;

    const svg = d3.select("#series");
    const W = Math.max(260, svg.node().getBoundingClientRect().width || 300), H = 170;
    const m = { t: 8, r: 4, b: 20, l: 26 };
    svg.attr("viewBox", `0 0 ${W} ${H}`).selectAll("*").remove();
    const x = d3.scaleBand(years, [m.l, W - m.r]).paddingInner(0.25);
    const ymax = d3.max(series) || 1;
    const y = d3.scaleLinear([0, ymax], [H - m.b, m.t]).nice();

    svg.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4).slice(1)).join("line")
      .attr("x1", m.l).attr("x2", W - m.r).attr("y1", y).attr("y2", y);
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(6)).call(g => g.select(".domain").remove());
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickValues(years.filter(v => v % 5 === 0)).tickSize(0).tickPadding(6))
      .call(g => g.select(".domain").attr("stroke", "#3a352f"));

    const early = d3.mean(series.slice(0, 10));
    const bw = x.bandwidth();
    const g = svg.append("g");
    g.selectAll("path").data(years).join("path")
      .attr("class", "bar")
      .attr("d", yr => roundedTop(x(yr), y(series[yi(yr)] || 0), bw, (H - m.b) - y(series[yi(yr)] || 0), Math.min(3, bw / 2)))
      .attr("fill", yr => (state.mode === "days" && yr === state.year) ? "#ffb27a" : dayColor(series[yi(yr)] ?? 0))
      .attr("opacity", yr => (partial && yr === meta.last_year ? 0.55 : 1))
      .on("click", (ev, yr) => { stop(); if (state.mode !== "days") setMode("days"); setYear(yr); })
      .on("pointerenter pointermove", (ev, yr) => {
        const v = series[yi(yr)];
        showHtmlTip(ev, `<div class="t-name">${yearLabel(yr)}</div><div class="t-big">${fmtDays(v)}<small>heatwave days</small></div>`);
      })
      .on("pointerleave", hideTip);
    // 2000–09 reference line
    if (early > 0) {
      svg.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(early)).attr("y2", y(early))
        .attr("stroke", "#c9c2b8").attr("stroke-width", 1).attr("stroke-dasharray", "4 3");
    }
  }

  function roundedTop(x, y, w, h, r) {
    if (h <= 0) return "";
    r = Math.min(r, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  // ---- top 10 ---------------------------------------------------------------
  function ranked() {
    return Object.entries(data)
      .map(([iso, c]) => ({ iso, name: c.name, v: valueOf(iso) }))
      .filter(d => d.v != null)
      .sort((a, b) => d3.descending(a.v, b.v) || d3.ascending(a.name, b.name));
  }
  function drawTop() {
    const rows = ranked().slice(0, 10);
    $("#topTitle").textContent = state.mode === "change"
      ? "Biggest increase since 2000–09"
      : `Most heatwave days, ${yearLabel(state.year)}`;
    const max = d3.max(rows, d => Math.abs(d.v)) || 1;
    const col = v => (state.mode === "change" ? chgColor(v) : dayColor(v));
    $("#top10").innerHTML = rows.map((d, i) => `
      <li data-iso="${d.iso}">
        <span class="rk">${i + 1}</span>
        <span class="nm"><span>${esc(d.name)}</span><span class="track"><i style="width:${(100 * Math.abs(d.v) / max).toFixed(1)}%;background:${col(d.v)}"></i></span></span>
        <span class="val">${state.mode === "change" ? fmtSigned(d.v) : fmtDays(d.v)}</span>
      </li>`).join("");
    document.querySelectorAll("#top10 li").forEach(li => li.addEventListener("click", () => select(li.dataset.iso)));
  }

  // ---- table ----------------------------------------------------------------
  function drawTable() {
    const rows = ranked();
    const vh = state.mode === "change" ? "Change (days/yr)" : `Heatwave days ${yearLabel(state.year)}`;
    $("#table").innerHTML =
      `<thead><tr><th>Country</th><th>Place</th><th class="num">${vh}</th><th class="num">2000–09 avg</th><th class="num">2016–25 avg</th></tr></thead><tbody>` +
      rows.map(d => {
        const c = data[d.iso];
        return `<tr><td>${esc(c.name)}</td><td>${esc(c.points.map(p => p.place).join(", "))}</td>` +
          `<td class="num">${state.mode === "change" ? fmtSigned(d.v) : fmtDays(d.v)}</td>` +
          `<td class="num">${fmtDays(c.mean_2000s)}</td><td class="num">${c.mean_recent == null ? "—" : fmtDays(c.mean_recent)}</td></tr>`;
      }).join("") + "</tbody>";
  }

  // ---- tooltip --------------------------------------------------------------
  function showTip(ev, iso, fallbackName) {
    const c = data[iso];
    if (!c) {
      showHtmlTip(ev, `<div class="t-name">${esc(fallbackName)}</div><div class="t-foot">Data still downloading — check back after the next daily update.</div>`);
      return;
    }
    const v = valueOf(iso);
    const big = state.mode === "change"
      ? `${fmtSigned(v)}<small>days/yr vs 2000–09</small>`
      : `${fmtDays(v)}<small>heatwave days in ${yearLabel(state.year)}</small>`;
    showHtmlTip(ev,
      `<div class="t-name">${esc(c.name)}</div>` +
      `<div class="t-place">${esc(c.points.map(p => p.place).join(", "))}</div>` +
      `<div class="t-big">${big}</div>` +
      spark(c.days) +
      `<div class="t-foot">2000–09 avg ${fmtDays(c.mean_2000s)} · 2016–25 avg ${c.mean_recent == null ? "—" : fmtDays(c.mean_recent)}</div>`);
  }

  function spark(series) {
    const W = 230, H = 44, n = series.length, bw = W / n;
    const max = Math.max(1, d3.max(series));
    const bars = series.map((v, i) => {
      const h = Math.max(v > 0 ? 1.5 : 0, (H - 2) * v / max);
      const yr = meta.first_year + i;
      const fill = state.mode === "days" && yr === state.year ? "#ffb27a" : dayColor(v);
      return `<rect x="${(i * bw + 0.5).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw - 1.5).toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${fill}"/>`;
    }).join("");
    return `<svg width="${W}" height="${H + 12}" viewBox="0 0 ${W} ${H + 12}">${bars}` +
      `<text x="0" y="${H + 11}" font-size="9.5" fill="#8f877c" font-family="IBM Plex Mono, monospace">${meta.first_year}</text>` +
      `<text x="${W}" y="${H + 11}" font-size="9.5" fill="#8f877c" text-anchor="end" font-family="IBM Plex Mono, monospace">${meta.last_year}</text></svg>`;
  }

  function showHtmlTip(ev, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 14, r = tip.getBoundingClientRect();
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }
  function hideTip() { tip.hidden = true; }

  // ---- PNG export (1080×1350, LinkedIn portrait) -----------------------------
  async function exportPng() {
    await document.fonts.ready;
    const W = 1080, H = 1350, S = 2;
    const cv = document.createElement("canvas");
    cv.width = W * S; cv.height = H * S;
    const ctx = cv.getContext("2d");
    ctx.scale(S, S);
    ctx.fillStyle = "#0f0e0d"; ctx.fillRect(0, 0, W, H);

    const isChg = state.mode === "change";
    const P = 64;
    ctx.fillStyle = "#ff7a3d";
    ctx.beginPath(); ctx.arc(P + 5, P + 2, 6, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = "#8f877c"; ctx.font = "500 20px 'IBM Plex Mono'"; ctx.textBaseline = "middle";
    ctx.fillText("ERA5 REANALYSIS · 2000 → 2026", P + 22, P + 3);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#f2eee8"; ctx.font = "600 76px Fraunces";
    ctx.fillText("Global Heatwave Map", P, P + 100);

    // big year / subtitle
    ctx.font = "500 120px 'IBM Plex Mono'"; ctx.fillStyle = "#ffb27a";
    const big = isChg ? "2016–25" : String(state.year);
    ctx.fillText(big, P, P + 250);
    ctx.font = "400 30px Fraunces"; ctx.fillStyle = "#c9c2b8";
    const sub = isChg ? "vs 2000–09: change in heatwave days per year"
      : partial && state.year === meta.last_year ? "heatwave days per country, year to date" : "heatwave days per country";
    ctx.fillText(sub, P, P + 300);

    // map
    const mapTop = 400, mapH = 520;
    const proj = d3.geoEqualEarth().fitExtent([[P - 20, mapTop], [W - P + 20, mapTop + mapH]], { type: "Sphere" });
    const gp = d3.geoPath(proj, ctx);
    ctx.beginPath(); gp({ type: "Sphere" }); ctx.fillStyle = "#151311"; ctx.fill();
    const hatch = (() => {
      const c = document.createElement("canvas"); c.width = c.height = 8;
      const x = c.getContext("2d"); x.fillStyle = "#1c1a17"; x.fillRect(0, 0, 8, 8);
      x.strokeStyle = "#2c2824"; x.lineWidth = 3; x.beginPath(); x.moveTo(-2, 10); x.lineTo(10, -2); x.stroke();
      return ctx.createPattern(c, "repeat");
    })();
    for (const f of geo.features) {
      const v = valueOf(f.properties.iso);
      ctx.beginPath(); gp(f);
      ctx.fillStyle = v == null ? hatch : colorOf(v); ctx.fill();
      ctx.strokeStyle = "#0f0e0d"; ctx.lineWidth = 0.6; ctx.stroke();
    }

    // legend
    const colors = isChg ? CHG_COLORS : DAY_COLORS;
    const labels = isChg ? ["", ...CHG_BREAKS.map(fmtSigned)] : ["0", ...DAY_BREAKS.map(b => fmt0(b))];
    const lw = 64, lx = P, ly = mapTop + mapH + 40;
    colors.forEach((c, i) => {
      ctx.fillStyle = c; roundRect(ctx, lx + i * (lw + 4), ly, lw, 14, 3); ctx.fill();
      ctx.fillStyle = "#8f877c"; ctx.font = "18px 'IBM Plex Mono'";
      ctx.fillText(labels[i] + (!isChg && i === colors.length - 1 ? "+" : ""), lx + i * (lw + 4), ly + 40);
    });

    // top 5
    const top = ranked().slice(0, 5);
    const tx = P, ty = ly + 100;
    ctx.fillStyle = "#c9c2b8"; ctx.font = "600 22px 'IBM Plex Sans'";
    ctx.fillText(isChg ? "Biggest increase" : "Most heatwave days", tx, ty);
    ctx.font = "22px 'IBM Plex Sans'";
    top.forEach((d, i) => {
      const yy = ty + 38 + i * 34;
      ctx.fillStyle = "#8f877c"; ctx.font = "20px 'IBM Plex Mono'"; ctx.fillText(String(i + 1), tx, yy);
      ctx.fillStyle = "#f2eee8"; ctx.font = "22px 'IBM Plex Sans'"; ctx.fillText(d.name, tx + 34, yy);
      ctx.fillStyle = "#ffb27a"; ctx.font = "500 22px 'IBM Plex Mono'"; ctx.textAlign = "right";
      ctx.fillText(isChg ? fmtSigned(d.v) : fmtDays(d.v), tx + 430, yy); ctx.textAlign = "left";
    });

    // definition + source
    const dx = 560;
    ctx.fillStyle = "#c9c2b8"; ctx.font = "600 22px 'IBM Plex Sans'"; ctx.fillText("Heatwave =", dx, ty);
    ctx.fillStyle = "#8f877c"; ctx.font = "20px 'IBM Plex Sans'";
    wrap(ctx, "3+ consecutive days with max temperature above the local 95th percentile for that calendar day (2000–2025 baseline).", dx, ty + 34, W - P - dx, 28);
    wrap(ctx, `ERA5 (ECMWF/Copernicus) via Open-Meteo · capital-city grid cells · data to ${meta.data_through}`, dx, ty + 150, W - P - dx, 28);

    ctx.fillStyle = "#5d574f"; ctx.font = "18px 'IBM Plex Mono'";
    ctx.fillText(REPO_URL.replace(/^https?:\/\//, ""), P, H - 40);

    const a = document.createElement("a");
    a.download = `heatwave-map-${isChg ? "change" : state.year}.png`;
    a.href = cv.toDataURL("image/png");
    a.click();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function wrap(ctx, text, x, y, maxW, lh) {
    let line = "";
    for (const w of text.split(" ")) {
      const t = line ? line + " " + w : w;
      if (ctx.measureText(t).width > maxW && line) { ctx.fillText(line, x, y); line = w; y += lh; }
      else line = t;
    }
    if (line) ctx.fillText(line, x, y);
  }

  // ---- utils ----------------------------------------------------------------
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
  function guessRepoUrl() {
    const { hostname, pathname } = location;
    const m = hostname.match(/^([^.]+)\.github\.io$/);
    if (m) {
      const repo = pathname.split("/").filter(Boolean)[0];
      return `https://github.com/${m[1]}/${repo || m[1] + ".github.io"}`;
    }
    return location.href;
  }
})();
