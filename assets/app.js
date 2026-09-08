/* Market Data Dashboard -- views over the vendor daily extract.

   Data arrives as plain scripts that populate window.MD (see data/*.js), so
   the page works from file:// as well as from a web server. Category files
   are pulled in on demand: opening 개요 does not download the 2.9 MB credit
   block.                                                                   */

(function () {
  'use strict';

  var MD = window.MD;
  var C = window.Charts;
  var esc = C.escapeHtml;

  var catalog = MD.catalog;
  var dates = MD.dates;
  var manifest = MD.manifest;
  var byId = {};
  catalog.forEach(function (row) { byId[row.series_id] = row; });

  var LAST = dates.length - 1;
  var MAX_SERIES = C.SERIES_SLOTS;

  /* ------------------------------------------------------ data access */

  var loaded = {};
  var pending = {};

  function loadCategories(names) {
    return Promise.all(names.map(loadCategory));
  }

  function loadCategory(name) {
    if (loaded[name]) return Promise.resolve(name);
    if (pending[name]) return pending[name];
    pending[name] = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'data/series/' + name + '.js';
      script.onload = function () { loaded[name] = true; resolve(name); };
      script.onerror = function () {
        reject(new Error('데이터 파일을 불러오지 못했습니다: ' + name));
      };
      document.head.appendChild(script);
    });
    return pending[name];
  }

  function categoryOf(code) {
    return byId[code] ? byId[code].category : null;
  }

  /* Values are stored trimmed -- {s: first index, v: [...]} -- so every read
     goes through the offset rather than indexing a full-length array. */
  function valueAt(code, i) {
    var rec = MD.series && MD.series[code];
    if (!rec) return null;
    var k = i - rec.s;
    if (k < 0 || k >= rec.v.length) return null;
    var v = rec.v[k];
    return (v === null || v === undefined) ? null : v;
  }

  function sliceOf(code, from, to) {
    var out = new Array(to - from + 1);
    for (var i = from; i <= to; i++) out[i - from] = valueAt(code, i);
    return out;
  }

  function lastValueIndex(code, upTo) {
    var end = (upTo === undefined) ? LAST : upTo;
    for (var i = end; i >= 0; i--) {
      if (valueAt(code, i) !== null) return i;
    }
    return -1;
  }

  /* Index of the last business day on or before `iso`. */
  function indexOnOrBefore(iso) {
    var lo = 0, hi = dates.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (dates[mid] <= iso) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best;
  }

  function shiftMonths(iso, months) {
    var p = iso.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    d.setUTCMonth(d.getUTCMonth() - months);
    return d.toISOString().slice(0, 10);
  }

  function indexMonthsBack(months, fromIndex) {
    var base = dates[fromIndex === undefined ? LAST : fromIndex];
    var i = indexOnOrBefore(shiftMonths(base, months));
    return i < 0 ? 0 : i;
  }

  /* --------------------------------------------------------- formatting */

  function isRateLike(unit) { return unit === 'percent' || unit === 'bp'; }

  function fmt(v, unit, digits) { return C.fmtValue(v, unit, digits); }

  function fmtWithUnit(v, unit) {
    if (v === null) return '–';
    return fmt(v, unit) + C.unitSuffix(unit);
  }

  /* Rate moves are quoted in basis points, levels in percent -- mixing the
     two is the classic way to make a dashboard lie. */
  function deltaText(now, then, unit) {
    if (now === null || then === null) return { text: '–', dir: 0 };
    if (isRateLike(unit)) {
      var bp = (unit === 'bp') ? (now - then) : (now - then) * 100;
      var r = Math.round(bp);
      return {
        text: (r > 0 ? '+' : '') + r.toLocaleString('en-US') + 'bp',
        dir: Math.sign(r)
      };
    }
    var pct = ((now - then) / Math.abs(then)) * 100;
    return {
      text: (pct > 0 ? '+' : '') + pct.toFixed(2) + '%',
      dir: Math.sign(+pct.toFixed(2))
    };
  }

  /* A rising yield is neither good nor bad, so direction is carried by an
     arrow in ordinary ink rather than by the reserved good/bad status
     colours -- and never by colour alone. */
  function dirMark(dir) {
    return dir > 0 ? '▲ ' : dir < 0 ? '▼ ' : '';
  }

  /* ------------------------------------------------------------- tables */

  /* Every chart ships a table view: three light-mode series colours sit below
     3:1 contrast, and the relief rule requires a text alternative. */
  function attachTableView(card, build) {
    var btn = card.querySelector('.table-toggle');
    var host = card.querySelector('.table-view');
    if (!btn || !host) return;
    btn.onclick = function () {
      var show = host.hidden;
      host.hidden = !show;
      btn.textContent = show ? '표 닫기' : '표로 보기';
      btn.setAttribute('aria-expanded', String(show));
      if (show) build(host);
    };
    if (!host.hidden) build(host);
  }

  function renderTable(host, columns, rows) {
    var html = '<div class="table-scroll"><table><thead><tr>';
    columns.forEach(function (c) { html += '<th>' + esc(c) + '</th>'; });
    html += '</tr></thead><tbody>';
    rows.forEach(function (r) {
      html += '<tr>';
      r.forEach(function (cell) { html += '<td>' + cell + '</td>'; });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    host.innerHTML = html;
  }

  /* ============================ 개요 ================================== */

  var OVERVIEW_TILES = [
    { code: '한국_3y', name: '국고 3년' },
    { code: '한국_10y', name: '국고 10년' },
    { code: '한국_기준금리', name: '한국 기준금리' },
    { code: 'UST10y', name: '미국 10년' },
    { code: 'FFR', name: '미국 기준금리' },
    { code: 'USDKRW', name: '달러/원' },
    { code: 'VKOSPI', name: 'VKOSPI' },
    { code: 'VIX', name: 'VIX' }
  ];

  var views = {};

  views.overview = {
    needs: ['RATE', 'FX', 'MACRO'],
    render: function (root) {
      root.innerHTML =
        '<div class="tiles" id="ov-tiles"></div>' +
        '<div class="grid cols-2" style="margin-top:18px">' +
        '  <section class="card" id="ov-curve">' +
        '    <header><h2>국고채 수익률 곡선</h2>' +
        '      <p class="note">현재 · 1개월 전 · 1년 전</p><span class="spacer"></span>' +
        '      <button class="table-toggle" aria-expanded="false">표로 보기</button></header>' +
        '    <div class="legend"></div><div class="chart"></div>' +
        '    <div class="table-view" hidden></div></section>' +
        '  <section class="card" id="ov-spread">' +
        '    <header><h2>주요 스프레드</h2>' +
        '      <p class="note">국고 10년−3년, 한·미 10년 · 최근 5년</p>' +
        '      <span class="spacer"></span>' +
        '      <button class="table-toggle" aria-expanded="false">표로 보기</button></header>' +
        '    <div class="legend"></div><div class="chart"></div>' +
        '    <div class="table-view" hidden></div></section>' +
        '</div>';
      this.tiles();
      this.curve();
      this.spread();
    },

    tiles: function () {
      var host = document.getElementById('ov-tiles');
      host.innerHTML = '';
      OVERVIEW_TILES.forEach(function (spec, n) {
        var row = byId[spec.code];
        if (!row) return;
        var iLast = lastValueIndex(spec.code);
        if (iLast < 0) return;
        var unit = row.unit;
        var now = valueAt(spec.code, iLast);
        var d1 = deltaText(now, valueAt(spec.code, lastValueIndex(spec.code, iLast - 1)), unit);
        var dM = deltaText(now, valueAt(spec.code, lastValueIndex(spec.code, indexMonthsBack(1, iLast))), unit);
        var dY = deltaText(now, valueAt(spec.code, lastValueIndex(spec.code, indexMonthsBack(12, iLast))), unit);

        var tile = document.createElement('div');
        tile.className = 'tile';
        tile.innerHTML =
          '<div class="label"><span>' + esc(spec.name) + '</span>' +
          '<span class="unit">' + esc(unitLabel(unit)) + '</span></div>' +
          '<div class="value">' + fmt(now, unit) + '</div>' +
          '<div class="deltas">' +
          '<span>1일 <b>' + dirMark(d1.dir) + d1.text + '</b></span>' +
          '<span>1개월 <b>' + dirMark(dM.dir) + dM.text + '</b></span>' +
          '<span>1년 <b>' + dirMark(dY.dir) + dY.text + '</b></span>' +
          '</div><div class="spark"></div>';
        host.appendChild(tile);
        var from = indexMonthsBack(12, iLast);
        C.sparkline(tile.querySelector('.spark'),
          sliceOf(spec.code, from, iLast), n);
      });
    },

    curve: function () {
      var card = document.getElementById('ov-curve');
      var members = curveMembers('KR');
      var picks = [
        { label: dates[LAST], idx: LAST },
        { label: dates[indexMonthsBack(1)], idx: indexMonthsBack(1) },
        { label: dates[indexMonthsBack(12)], idx: indexMonthsBack(12) }
      ];
      var series = picks.map(function (p, n) {
        return {
          key: p.label, label: p.label, slot: n, unit: 'percent',
          values: members.map(function (m) { return valueAt(m.series_id, p.idx); })
        };
      });
      var labels = members.map(function (m) { return m.tenor_label; });
      drawLegend(card.querySelector('.legend'), series);
      new C.LineChart(card.querySelector('.chart'), {
        series: series, x: { labels: labels, type: 'ordinal', title: '잔존만기' },
        unit: 'percent', height: 300
      });
      attachTableView(card, function (host) {
        renderTable(host, ['잔존만기'].concat(picks.map(function (p) { return p.label; })),
          members.map(function (m, i) {
            return [esc(m.tenor_label)].concat(series.map(function (s) {
              return fmtWithUnit(s.values[i], 'percent');
            }));
          }));
      });
    },

    spread: function () {
      var card = document.getElementById('ov-spread');
      var from = indexMonthsBack(60);
      var labels = dates.slice(from, LAST + 1);
      // both series are basis-point spreads, so they share one axis honestly
      var term = [], krus = [];
      for (var i = from; i <= LAST; i++) {
        var k10 = valueAt('한국_10y', i), k3 = valueAt('한국_3y', i);
        var u10 = valueAt('UST10y', i);
        term.push(k10 !== null && k3 !== null ? (k10 - k3) * 100 : null);
        krus.push(k10 !== null && u10 !== null ? (k10 - u10) * 100 : null);
      }
      var series = [
        { key: 'term', label: '국고 10년−3년', slot: 0, unit: 'bp', values: term },
        { key: 'krus', label: '한국−미국 10년', slot: 1, unit: 'bp', values: krus }
      ];
      drawLegend(card.querySelector('.legend'), series);
      new C.LineChart(card.querySelector('.chart'), {
        series: series, x: { labels: labels, type: 'date' },
        unit: 'bp', height: 300, tickDigits: 0, digits: 0
      });
      attachTableView(card, function (host) {
        var rows = [];
        for (var i = labels.length - 1; i >= 0; i -= 21) {
          rows.push([esc(labels[i]), fmtWithUnit(term[i], 'bp'), fmtWithUnit(krus[i], 'bp')]);
        }
        renderTable(host, ['일자', '국고 10년−3년', '한국−미국 10년'], rows);
      });
    }
  };

  function unitLabel(unit) {
    return unit === 'percent' ? '%' : unit === 'bp' ? 'bp'
      : unit === 'krw' ? '원' : unit === 'index' ? '지수' : '';
  }

  function drawLegend(host, series) {
    if (!host) return;
    host.innerHTML = series.map(function (s) {
      return '<span class="item"><span class="swatch" style="background:' +
        C.seriesColor(s.slot) + '"></span>' + esc(s.label) + '</span>';
    }).join('');
  }

  /* ======================== 수익률 곡선 =============================== */

  var COUNTRIES = [
    { code: 'KR', label: '한국 국고채' },
    { code: 'US', label: '미국 국채' },
    { code: 'JP', label: '일본 국채' },
    { code: 'AU', label: '호주 국채' },
    { code: 'EU', label: '독일 국채' }
  ];

  function curveMembers(country) {
    return catalog.filter(function (r) {
      return r.group === country + '_GOVT';
    }).sort(function (a, b) { return a.tenor_years - b.tenor_years; });
  }

  views.curve = {
    needs: ['RATE'],
    state: { country: 'KR', picks: null, mode: 'dates' },
    render: function (root) {
      var self = this;
      if (!this.state.picks) {
        this.state.picks = [LAST, indexMonthsBack(1), indexMonthsBack(12)];
      }
      root.innerHTML =
        '<section class="card">' +
        '  <header><h2>수익률 곡선 비교</h2><span class="spacer"></span>' +
        '    <button class="table-toggle" aria-expanded="false">표로 보기</button></header>' +
        '  <div class="controls">' +
        '    <label>국가</label><select id="cv-country"></select>' +
        '    <div class="segmented" id="cv-mode">' +
        '      <button data-mode="dates" aria-pressed="true">시점 비교</button>' +
        '      <button data-mode="countries" aria-pressed="false">국가 비교</button>' +
        '    </div>' +
        '    <span id="cv-date-controls">' +
        '      <label>시점 추가</label>' +
        '      <select id="cv-preset">' +
        '        <option value="">기간 선택…</option>' +
        '        <option value="0">최신</option><option value="1">1개월 전</option>' +
        '        <option value="3">3개월 전</option><option value="6">6개월 전</option>' +
        '        <option value="12">1년 전</option><option value="36">3년 전</option>' +
        '        <option value="60">5년 전</option><option value="120">10년 전</option>' +
        '      </select>' +
        '      <input type="date" id="cv-custom" min="' + dates[0] + '" max="' + dates[LAST] + '">' +
        '    </span>' +
        '  </div>' +
        '  <div class="chip-row" id="cv-chips"></div>' +
        '  <div class="legend"></div><div class="chart" style="margin-top:6px"></div>' +
        '  <div class="table-view" hidden></div>' +
        '</section>';

      var sel = root.querySelector('#cv-country');
      sel.innerHTML = COUNTRIES.map(function (c) {
        return '<option value="' + c.code + '">' + esc(c.label) + '</option>';
      }).join('');
      sel.value = this.state.country;
      sel.onchange = function () { self.state.country = this.value; self.draw(); };

      root.querySelectorAll('#cv-mode button').forEach(function (b) {
        b.onclick = function () {
          self.state.mode = b.dataset.mode;
          root.querySelectorAll('#cv-mode button').forEach(function (x) {
            x.setAttribute('aria-pressed', String(x === b));
          });
          root.querySelector('#cv-date-controls').style.display =
            self.state.mode === 'dates' ? '' : 'none';
          root.querySelector('#cv-country').disabled = self.state.mode === 'countries';
          self.draw();
        };
      });

      root.querySelector('#cv-preset').onchange = function () {
        if (this.value === '') return;
        self.addPick(this.value === '0' ? LAST : indexMonthsBack(+this.value));
        this.value = '';
      };
      root.querySelector('#cv-custom').onchange = function () {
        if (!this.value) return;
        var i = indexOnOrBefore(this.value);
        if (i >= 0) self.addPick(i);
      };
      this.root = root;
      this.draw();
    },

    addPick: function (i) {
      if (this.state.picks.indexOf(i) >= 0) return;
      if (this.state.picks.length >= 4) this.state.picks.shift();
      this.state.picks.push(i);
      this.state.picks.sort(function (a, b) { return b - a; });
      this.draw();
    },

    draw: function () {
      var self = this;
      var root = this.root;
      var card = root.querySelector('.card');
      var chips = root.querySelector('#cv-chips');
      var members, series, labels, columns;

      if (this.state.mode === 'countries') {
        chips.innerHTML = '';
        var day = this.state.picks[0] === undefined ? LAST : this.state.picks[0];
        // A shared tenor grid keeps the curves on one comparable x axis.
        var grid = [0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30];
        labels = grid.map(tenorLabel);
        series = COUNTRIES.map(function (c, n) {
          var ms = curveMembers(c.code);
          return {
            key: c.code, label: c.label, slot: n, unit: 'percent',
            values: grid.map(function (t) { return interpolateCurve(ms, t, day); })
          };
        });
        columns = ['잔존만기'].concat(series.map(function (s) { return s.label; }));
      } else {
        members = curveMembers(this.state.country);
        labels = members.map(function (m) { return m.tenor_label; });
        series = this.state.picks.map(function (idx, n) {
          return {
            key: String(idx), label: dates[idx], slot: n, unit: 'percent',
            values: members.map(function (m) { return valueAt(m.series_id, idx); })
          };
        });
        chips.innerHTML = this.state.picks.map(function (idx, n) {
          return '<span class="chip"><span class="swatch" style="background:' +
            C.seriesColor(n) + '"></span>' + esc(dates[idx]) +
            '<button data-idx="' + idx + '" aria-label="제거">×</button></span>';
        }).join('');
        chips.querySelectorAll('button').forEach(function (b) {
          b.onclick = function () {
            if (self.state.picks.length <= 1) return;
            self.state.picks = self.state.picks.filter(function (v) {
              return v !== +b.dataset.idx;
            });
            self.draw();
          };
        });
        columns = ['잔존만기'].concat(series.map(function (s) { return s.label; }));
      }

      drawLegend(root.querySelector('.legend'), series);
      new C.LineChart(root.querySelector('.chart'), {
        series: series, x: { labels: labels, type: 'ordinal', title: '잔존만기' },
        unit: 'percent', height: 400
      });
      attachTableView(card, function (host) {
        renderTable(host, columns, labels.map(function (lab, i) {
          return [esc(lab)].concat(series.map(function (s) {
            return fmtWithUnit(s.values[i], 'percent');
          }));
        }));
      });
    }
  };

  function tenorLabel(years) {
    return years < 1 ? Math.round(years * 12) + 'M'
      : (years % 1 ? years : Math.round(years)) + 'Y';
  }

  /* Linear interpolation along the tenor axis; no extrapolation beyond the
     quoted ends, which would invent a yield the vendor never published. */
  function interpolateCurve(members, tenor, dayIndex) {
    var pts = [];
    members.forEach(function (m) {
      var v = valueAt(m.series_id, dayIndex);
      if (v !== null && m.tenor_years) pts.push([m.tenor_years, v]);
    });
    if (!pts.length) return null;
    pts.sort(function (a, b) { return a[0] - b[0]; });
    if (tenor < pts[0][0] || tenor > pts[pts.length - 1][0]) return null;
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      if (tenor >= a[0] && tenor <= b[0]) {
        if (b[0] === a[0]) return a[1];
        var w = (tenor - a[0]) / (b[0] - a[0]);
        return a[1] + w * (b[1] - a[1]);
      }
    }
    return null;
  }

  /* ========================== 시계열 ================================= */

  views.series = {
    needs: [],
    state: { picked: ['한국_3y', '한국_10y', 'UST10y'], months: 60, mode: 'raw' },
    render: function (root) {
      var self = this;
      root.innerHTML =
        '<section class="card">' +
        '  <header><h2>시계열 비교</h2>' +
        '    <p class="note">최대 ' + MAX_SERIES + '개 계열</p><span class="spacer"></span>' +
        '    <button class="table-toggle" aria-expanded="false">표로 보기</button></header>' +
        '  <div class="controls">' +
        '    <input type="search" id="ts-search" placeholder="계열 검색 (예: 국고, Corp_AA, UST)" style="min-width:260px">' +
        '    <div class="segmented" id="ts-range">' +
        '      <button data-m="12">1년</button><button data-m="36">3년</button>' +
        '      <button data-m="60" aria-pressed="true">5년</button>' +
        '      <button data-m="120">10년</button><button data-m="0">전체</button>' +
        '    </div>' +
        '    <div class="segmented" id="ts-mode">' +
        '      <button data-mode="raw" aria-pressed="true">원계열</button>' +
        '      <button data-mode="index">지수화 (=100)</button>' +
        '    </div>' +
        '  </div>' +
        '  <div class="chip-row" id="ts-chips"></div>' +
        '  <div id="ts-picker"></div>' +
        '  <p class="note" id="ts-warn" style="margin:8px 0 0"></p>' +
        '  <div class="legend"></div><div class="chart" style="margin-top:6px"></div>' +
        '  <div class="table-view" hidden></div>' +
        '</section>';

      root.querySelector('#ts-search').oninput = function () {
        self.picker(this.value.trim());
      };
      root.querySelectorAll('#ts-range button').forEach(function (b) {
        b.onclick = function () {
          self.state.months = +b.dataset.m;
          root.querySelectorAll('#ts-range button').forEach(function (x) {
            x.setAttribute('aria-pressed', String(x === b));
          });
          self.draw();
        };
      });
      root.querySelectorAll('#ts-mode button').forEach(function (b) {
        b.onclick = function () {
          self.state.mode = b.dataset.mode;
          self.syncMode();
          self.draw();
        };
      });
      this.root = root;
      this.picker('');
      this.draw();
    },

    syncMode: function () {
      var self = this;
      this.root.querySelectorAll('#ts-mode button').forEach(function (x) {
        x.setAttribute('aria-pressed', String(x.dataset.mode === self.state.mode));
      });
    },

    picker: function (query) {
      var self = this;
      var host = this.root.querySelector('#ts-picker');
      if (!query) { host.innerHTML = ''; return; }
      var q = query.toLowerCase();
      var hits = catalog.filter(function (r) {
        return r.series_id.toLowerCase().indexOf(q) >= 0 ||
          (r.vendor_ticker || '').toLowerCase().indexOf(q) >= 0 ||
          (r.field || '').toLowerCase().indexOf(q) >= 0;
      }).slice(0, 60);
      if (!hits.length) {
        host.innerHTML = '<div class="picker-list"><div class="empty">검색 결과가 없습니다</div></div>';
        return;
      }
      host.innerHTML = '<div class="picker-list">' + hits.map(function (r) {
        var on = self.state.picked.indexOf(r.series_id) >= 0;
        return '<button data-code="' + esc(r.series_id) + '"' + (on ? ' disabled' : '') + '>' +
          esc(r.series_id) + ' <span class="meta">· ' + esc(r.vendor_ticker || '') +
          ' · ' + esc(r.category) + ' · ' + esc(unitLabel(r.unit)) +
          (on ? ' · 선택됨' : '') + '</span></button>';
      }).join('') + '</div>';
      host.querySelectorAll('button[data-code]').forEach(function (b) {
        b.onclick = function () {
          if (self.state.picked.length >= MAX_SERIES) return;
          self.state.picked.push(b.dataset.code);
          self.draw();
          self.picker(self.root.querySelector('#ts-search').value.trim());
        };
      });
    },

    draw: function () {
      var self = this;
      var root = this.root;
      var picked = this.state.picked;
      var chips = root.querySelector('#ts-chips');

      chips.innerHTML = picked.map(function (code, n) {
        return '<span class="chip"><span class="swatch" style="background:' +
          C.seriesColor(n) + '"></span>' + esc(code) +
          '<button data-code="' + esc(code) + '" aria-label="제거">×</button></span>';
      }).join('');
      chips.querySelectorAll('button').forEach(function (b) {
        b.onclick = function () {
          self.state.picked = picked.filter(function (c) { return c !== b.dataset.code; });
          self.draw();
          self.picker(root.querySelector('#ts-search').value.trim());
        };
      });

      if (!picked.length) {
        root.querySelector('.chart').innerHTML =
          '<div class="empty">비교할 계열을 검색해 추가하세요</div>';
        root.querySelector('.legend').innerHTML = '';
        root.querySelector('#ts-warn').textContent = '';
        return;
      }

      var cats = {};
      picked.forEach(function (c) { var k = categoryOf(c); if (k) cats[k] = 1; });
      loadCategories(Object.keys(cats)).then(function () {
        self.plot();
      }).catch(function (e) {
        root.querySelector('.chart').innerHTML =
          '<div class="empty">' + esc(e.message) + '</div>';
      });
    },

    plot: function () {
      var root = this.root;
      var picked = this.state.picked;
      var from = this.state.months ? indexMonthsBack(this.state.months) : 0;
      var labels = dates.slice(from, LAST + 1);

      // One axis, always. Mixed units cannot share a scale honestly, so the
      // view switches itself to an indexed comparison and says why.
      var units = {};
      picked.forEach(function (c) { units[byId[c] ? byId[c].unit : '?'] = 1; });
      var unitKeys = Object.keys(units);
      var mixed = unitKeys.length > 1;
      var mode = mixed ? 'index' : this.state.mode;
      var warn = root.querySelector('#ts-warn');
      warn.textContent = mixed
        ? '단위가 다른 계열(' + unitKeys.map(unitLabel).join(', ') +
          ')이 섞여 있어 지수화(구간 시작 = 100) 기준으로 비교합니다.'
        : '';
      if (mixed) {
        root.querySelectorAll('#ts-mode button').forEach(function (x) {
          x.setAttribute('aria-pressed', String(x.dataset.mode === 'index'));
        });
      } else {
        this.syncMode();
      }

      var series = picked.map(function (code, n) {
        var raw = sliceOf(code, from, LAST);
        var values = raw;
        if (mode === 'index') {
          var base = null;
          for (var i = 0; i < raw.length; i++) {
            if (raw[i] !== null && raw[i] !== 0) { base = raw[i]; break; }
          }
          values = raw.map(function (v) {
            return (v === null || base === null) ? null : (v / base) * 100;
          });
        }
        return {
          key: code, label: code, slot: n,
          unit: mode === 'index' ? 'index' : (byId[code] ? byId[code].unit : 'percent'),
          values: values
        };
      });

      drawLegend(root.querySelector('.legend'), series);
      new C.LineChart(root.querySelector('.chart'), {
        series: series, x: { labels: labels, type: 'date' },
        unit: mode === 'index' ? 'index' : unitKeys[0],
        height: 420, directLabels: series.length <= 4
      });

      attachTableView(root.querySelector('.card'), function (host) {
        var rows = [];
        for (var i = labels.length - 1; i >= 0; i -= Math.max(1, Math.floor(labels.length / 260))) {
          rows.push([esc(labels[i])].concat(series.map(function (s) {
            return fmtWithUnit(s.values[i], s.unit);
          })));
        }
        renderTable(host, ['일자'].concat(picked.map(esc)), rows);
      });
    }
  };

  /* =========================== 크레딧 ================================ */

  var CREDIT_TENORS = [0.25, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 15];

  views.credit = {
    needs: ['CREDIT', 'RATE'],
    state: { dayIndex: null, metric: 'spread', selected: null },
    render: function (root) {
      var self = this;
      if (this.state.dayIndex === null) this.state.dayIndex = LAST;
      root.innerHTML =
        '<section class="card" id="cr-matrix">' +
        '  <header><h2>크레딧 스프레드 매트릭스</h2>' +
        '    <p class="note">등급·잔존만기별, 동일 만기 국고채 대비 (bp)</p>' +
        '    <span class="spacer"></span>' +
        '    <button class="table-toggle" aria-expanded="false">표로 보기</button></header>' +
        '  <div class="controls">' +
        '    <label>기준일</label>' +
        '    <input type="date" id="cr-date" min="' + dates[0] + '" max="' + dates[LAST] + '">' +
        '    <div class="segmented" id="cr-metric">' +
        '      <button data-metric="spread" aria-pressed="true">국고 대비 스프레드</button>' +
        '      <button data-metric="yield" aria-pressed="false">절대 금리</button>' +
        '    </div>' +
        '  </div>' +
        '  <div class="heat-grid"></div>' +
        '  <div class="heat-legend"></div>' +
        '  <div class="table-view" hidden></div>' +
        '</section>' +
        '<section class="card" id="cr-series">' +
        '  <header><h2 id="cr-series-title">스프레드 추이</h2>' +
        '    <p class="note">매트릭스에서 셀을 클릭하면 해당 계열의 추이를 표시합니다</p></header>' +
        '  <div class="legend"></div><div class="chart"></div>' +
        '</section>';

      var dateInput = root.querySelector('#cr-date');
      dateInput.value = dates[this.state.dayIndex];
      dateInput.onchange = function () {
        var i = indexOnOrBefore(this.value);
        if (i >= 0) { self.state.dayIndex = i; this.value = dates[i]; self.matrix(); }
      };
      root.querySelectorAll('#cr-metric button').forEach(function (b) {
        b.onclick = function () {
          self.state.metric = b.dataset.metric;
          root.querySelectorAll('#cr-metric button').forEach(function (x) {
            x.setAttribute('aria-pressed', String(x === b));
          });
          self.matrix();
        };
      });
      this.root = root;
      this.matrix();
      this.trend();
    },

    rows: function () {
      var seen = {}, out = [];
      catalog.forEach(function (r) {
        if (r.role !== 'credit_curve') return;
        var key = r.group + '|' + r.rating;
        if (seen[key]) return;
        seen[key] = 1;
        out.push({ group: r.group, rating: r.rating, key: key, label: groupLabel(r.group) + ' ' + r.rating });
      });
      return out;
    },

    codeFor: function (row, tenor) {
      var hit = catalog.filter(function (r) {
        return r.role === 'credit_curve' && r.group === row.group &&
          r.rating === row.rating && Math.abs(r.tenor_years - tenor) < 1e-6;
      });
      return hit.length ? hit[0].series_id : null;
    },

    valueFor: function (row, tenor) {
      var code = this.codeFor(row, tenor);
      if (!code) return null;
      var y = valueAt(code, this.state.dayIndex);
      if (y === null) return null;
      if (this.state.metric === 'yield') return y;
      var base = interpolateCurve(curveMembers('KR'), tenor, this.state.dayIndex);
      return base === null ? null : (y - base) * 100;
    },

    matrix: function () {
      var self = this;
      var card = this.root.querySelector('#cr-matrix');
      var host = card.querySelector('.heat-grid');
      var rows = this.rows();
      var cols = CREDIT_TENORS.map(function (t) {
        return { tenor: t, label: tenorLabel(t) };
      });
      var isSpread = this.state.metric === 'spread';
      var range = C.heatmap(host, {
        rows: rows, cols: cols, corner: '등급 \\ 만기',
        unit: isSpread ? 'bp' : 'percent',
        digits: isSpread ? 0 : 2,
        valueAt: function (r, c) { return self.valueFor(r, c.tenor); },
        onCell: function (r, c) {
          self.state.selected = { row: r, tenor: c.tenor };
          self.trend();
          document.getElementById('cr-series').scrollIntoView({
            behavior: 'smooth', block: 'nearest'
          });
        }
      });

      card.querySelector('.heat-legend').innerHTML =
        '<span>' + C.fmtValue(range.min, isSpread ? 'bp' : 'percent', isSpread ? 0 : 2) +
        C.unitSuffix(isSpread ? 'bp' : 'percent') + '</span>' +
        '<span class="ramp">' +
        ['--seq-100', '--seq-200', '--seq-300', '--seq-400', '--seq-500', '--seq-600', '--seq-700']
          .map(function (v) { return '<span style="background:var(' + v + ')"></span>'; }).join('') +
        '</span><span>' +
        C.fmtValue(range.max, isSpread ? 'bp' : 'percent', isSpread ? 0 : 2) +
        C.unitSuffix(isSpread ? 'bp' : 'percent') + '</span>' +
        '<span style="margin-left:8px">기준일 ' + esc(dates[this.state.dayIndex]) + '</span>';

      attachTableView(card, function (tHost) {
        renderTable(tHost, ['등급'].concat(cols.map(function (c) { return c.label; })),
          rows.map(function (r) {
            return [esc(r.label)].concat(cols.map(function (c) {
              var v = self.valueFor(r, c.tenor);
              return v === null ? '–'
                : C.fmtValue(v, isSpread ? 'bp' : 'percent', isSpread ? 0 : 2) +
                  C.unitSuffix(isSpread ? 'bp' : 'percent');
            }));
          }));
      });
    },

    trend: function () {
      var card = this.root.querySelector('#cr-series');
      var sel = this.state.selected;
      if (!sel) {
        sel = { row: { group: 'CORP', rating: 'AA-', label: '회사채 AA-' }, tenor: 3 };
      }
      var code = this.codeFor(sel.row, sel.tenor);
      if (!code) {
        card.querySelector('.chart').innerHTML =
          '<div class="empty">해당 등급·만기 계열이 없습니다</div>';
        return;
      }
      var from = indexMonthsBack(60);
      var labels = dates.slice(from, LAST + 1);
      var krMembers = curveMembers('KR');
      var spread = [], yield_ = [];
      for (var i = from; i <= LAST; i++) {
        var y = valueAt(code, i);
        var base = interpolateCurve(krMembers, sel.tenor, i);
        yield_.push(y);
        spread.push(y !== null && base !== null ? (y - base) * 100 : null);
      }
      document.getElementById('cr-series-title').textContent =
        groupLabel(sel.row.group) + ' ' + sel.row.rating + ' ' +
        tenorLabel(sel.tenor) + ' · 국고 대비 스프레드 (최근 5년)';
      var series = [{
        key: code, label: code + ' 스프레드', slot: 0, unit: 'bp', values: spread
      }];
      drawLegend(card.querySelector('.legend'), []);
      new C.LineChart(card.querySelector('.chart'), {
        series: series, x: { labels: labels, type: 'date' },
        unit: 'bp', height: 300, digits: 0, tickDigits: 0
      });
    }
  };

  function groupLabel(g) {
    return ({
      CD: '은행 CD', CP: '기업어음', PUBLIC: '공사채', KDB: '특수채',
      BANK: '은행채', CARD: '여전채', CORP: '회사채'
    })[g] || g;
  }

  /* ========================== FX & 헤지 ============================== */

  views.fx = {
    needs: ['FX', 'HEDGE'],
    state: { months: 60 },
    render: function (root) {
      var self = this;
      // Nine FX series exceed the eight categorical slots, so they are
      // faceted into two charts by what they measure rather than truncated.
      root.innerHTML =
        '<div class="controls" style="margin-bottom:16px">' +
        '  <label>기간</label>' +
        '  <div class="segmented" id="fx-range">' +
        '    <button data-m="12">1년</button><button data-m="36">3년</button>' +
        '    <button data-m="60" aria-pressed="true">5년</button>' +
        '    <button data-m="0">전체</button></div>' +
        '</div>' +
        '<div class="grid cols-2">' +
        '<section class="card" id="fx-krw">' +
        '  <header><h2>원화 환율</h2>' +
        '    <p class="note">구간 시작 = 100 지수화 · 상승 = 원화 약세</p>' +
        '    <span class="spacer"></span>' +
        '    <button class="table-toggle" aria-expanded="false">표로 보기</button></header>' +
        '  <div class="legend"></div><div class="chart"></div>' +
        '  <div class="table-view" hidden></div>' +
        '</section>' +
        '<section class="card" id="fx-global">' +
        '  <header><h2>주요 통화 · 달러지수</h2>' +
        '    <p class="note">구간 시작 = 100 지수화</p>' +
        '    <span class="spacer"></span>' +
        '    <button class="table-toggle" aria-expanded="false">표로 보기</button></header>' +
        '  <div class="legend"></div><div class="chart"></div>' +
        '  <div class="table-view" hidden></div>' +
        '</section>' +
        '</div>' +
        '<section class="card" id="fx-hedge">' +
        '  <header><h2>통화별 헤지 프리미엄</h2>' +
        '    <p class="note">모두 % 단위이므로 원계열 그대로 비교</p>' +
        '    <span class="spacer"></span>' +
        '    <button class="table-toggle" aria-expanded="false">표로 보기</button></header>' +
        '  <div class="controls"><label>만기</label>' +
        '    <div class="segmented" id="fx-tenor">' +
        '      <button data-t="3M" aria-pressed="true">3개월</button>' +
        '      <button data-t="6M">6개월</button>' +
        '      <button data-t="12M">12개월</button></div>' +
        '  </div>' +
        '  <div class="legend"></div><div class="chart"></div>' +
        '  <div class="table-view" hidden></div>' +
        '</section>';

      root.querySelectorAll('#fx-range button').forEach(function (b) {
        b.onclick = function () {
          self.state.months = +b.dataset.m;
          root.querySelectorAll('#fx-range button').forEach(function (x) {
            x.setAttribute('aria-pressed', String(x === b));
          });
          self.rates();
        };
      });
      root.querySelectorAll('#fx-tenor button').forEach(function (b) {
        b.onclick = function () {
          root.querySelectorAll('#fx-tenor button').forEach(function (x) {
            x.setAttribute('aria-pressed', String(x === b));
          });
          self.hedge(b.dataset.t);
        };
      });
      this.root = root;
      this.rates();
      this.hedge('3M');
    },

    rates: function () {
      this.facet('#fx-krw', ['USDKRW', 'EURKRW', 'AUDKRW', 'KRWJPY']);
      this.facet('#fx-global', ['DXY', 'USDJPY', 'USDCNY', 'USDEUR', 'AUDUSD']);
    },

    facet: function (selector, wanted) {
      var card = this.root.querySelector(selector);
      var codes = wanted.filter(function (c) { return !!byId[c]; });
      var from = this.state.months ? indexMonthsBack(this.state.months) : 0;
      var labels = dates.slice(from, LAST + 1);
      var series = codes.map(function (code, n) {
        var raw = sliceOf(code, from, LAST);
        var base = null;
        for (var i = 0; i < raw.length; i++) {
          if (raw[i] !== null && raw[i] !== 0) { base = raw[i]; break; }
        }
        return {
          key: code, label: code, slot: n, unit: 'index',
          values: raw.map(function (v) {
            return (v === null || base === null) ? null : (v / base) * 100;
          })
        };
      });
      drawLegend(card.querySelector('.legend'), series);
      new C.LineChart(card.querySelector('.chart'), {
        series: series, x: { labels: labels, type: 'date' },
        unit: 'index', height: 340, digits: 1
      });
      // The table carries the actual quoted levels, not the indexed values,
      // so the underlying numbers stay available.
      attachTableView(card, function (host) {
        var rows = [];
        for (var i = labels.length - 1; i >= 0; i -= Math.max(1, Math.floor(labels.length / 260))) {
          rows.push([esc(labels[i])].concat(codes.map(function (code) {
            return fmtWithUnit(valueAt(code, from + i), byId[code].unit);
          })));
        }
        renderTable(host, ['일자'].concat(codes.map(esc)), rows);
      });
    },

    hedge: function (tenor) {
      var card = this.root.querySelector('#fx-hedge');
      var codes = catalog.filter(function (r) {
        return r.category === 'HEDGE' && r.tenor_label === tenor;
      }).map(function (r) { return r.series_id; });
      var first = codes.reduce(function (acc, c) {
        var rec = MD.series[c];
        return rec ? Math.min(acc, rec.s) : acc;
      }, LAST);
      var labels = dates.slice(first, LAST + 1);
      var series = codes.map(function (code, n) {
        return {
          key: code, label: code.replace('_HP_' + tenor, ''), slot: n,
          unit: 'percent', values: sliceOf(code, first, LAST)
        };
      });
      drawLegend(card.querySelector('.legend'), series);
      new C.LineChart(card.querySelector('.chart'), {
        series: series, x: { labels: labels, type: 'date' },
        unit: 'percent', height: 340
      });
      attachTableView(card, function (host) {
        var rows = [];
        for (var i = labels.length - 1; i >= 0; i -= Math.max(1, Math.floor(labels.length / 260))) {
          rows.push([esc(labels[i])].concat(series.map(function (s) {
            return fmtWithUnit(s.values[i], 'percent');
          })));
        }
        renderTable(host, ['일자'].concat(series.map(function (s) { return esc(s.label); })), rows);
      });
    }
  };

  /* ========================= 데이터 품질 ============================= */

  views.quality = {
    needs: [],
    state: { sort: 'series_id', dir: 1, category: '', query: '' },
    render: function (root) {
      var self = this;
      var q = manifest.quality;
      root.innerHTML =
        '<div class="tiles">' +
        tile('계열 수', manifest.n_series.toLocaleString(), '개') +
        tile('영업일 수', manifest.n_dates.toLocaleString(), manifest.first_date + ' ~ ' + manifest.last_date) +
        tile('관측치', manifest.total_obs.toLocaleString(), '개') +
        tile('데이터 밀도', manifest.density_pct + '%', '전체 격자 대비') +
        tile('보정된 값', q.n_masked.toLocaleString(), '벤더 인코딩 아티팩트') +
        '</div>' +
        '<section class="card" style="margin-top:18px">' +
        '  <header><h2>보정 규칙</h2>' +
        '    <p class="note">원본은 Data 저장소에 그대로 보존되며, 아래 규칙에 해당하는 값만 결측 처리했습니다</p></header>' +
        '  <div class="table-scroll"><table><thead><tr><th>규칙</th><th style="text-align:left">설명</th><th>건수</th></tr></thead><tbody>' +
        Object.keys(q.rules).map(function (k) {
          var n = 0;
          Object.keys(q.per_series).forEach(function (s) { n += q.per_series[s][k] || 0; });
          return '<tr><td>' + esc(k) + '</td><td style="text-align:left;white-space:normal">' +
            esc(q.rules[k]) + '</td><td>' + n.toLocaleString() + '</td></tr>';
        }).join('') +
        '</tbody></table></div>' +
        '  <p class="note" style="margin-top:12px">' + esc(q.not_flagged) + '</p>' +
        (q.notable.length ? '<p class="note" style="margin-top:8px"><b>개별 확인된 자릿수 오류:</b> ' +
          q.notable.map(function (i) {
            return esc(i.series_id) + ' ' + esc(i.date) + ' = ' +
              i.value.toLocaleString() + ' (전후 ' + i.neighbours.join(', ') + ', ' + i.ratio + '배)';
          }).join(' · ') + '</p>' : '') +
        '</section>' +
        '<section class="card">' +
        '  <header><h2>계열 카탈로그</h2><span class="spacer"></span></header>' +
        '  <div class="controls">' +
        '    <input type="search" id="ql-search" placeholder="계열 검색" style="min-width:240px">' +
        '    <label>분류</label><select id="ql-cat"><option value="">전체</option>' +
        Object.keys(manifest.categories).map(function (c) {
          return '<option value="' + c + '">' + c + ' (' + manifest.categories[c] + ')</option>';
        }).join('') +
        '    </select><span class="note" id="ql-count"></span>' +
        '  </div>' +
        '  <div id="ql-table"></div>' +
        '</section>';

      root.querySelector('#ql-search').oninput = function () {
        self.state.query = this.value.trim().toLowerCase(); self.table();
      };
      root.querySelector('#ql-cat').onchange = function () {
        self.state.category = this.value; self.table();
      };
      this.root = root;
      this.table();
    },

    table: function () {
      var self = this;
      var st = this.state;
      var rows = catalog.filter(function (r) {
        if (st.category && r.category !== st.category) return false;
        if (!st.query) return true;
        return r.series_id.toLowerCase().indexOf(st.query) >= 0 ||
          (r.vendor_ticker || '').toLowerCase().indexOf(st.query) >= 0;
      });
      rows.sort(function (a, b) {
        var x = a[st.sort], y = b[st.sort];
        if (x === null) return 1;
        if (y === null) return -1;
        return (x > y ? 1 : x < y ? -1 : 0) * st.dir;
      });
      this.root.querySelector('#ql-count').textContent =
        rows.length + ' / ' + catalog.length + ' 계열';

      var cols = [
        ['series_id', '계열'], ['category', '분류'], ['country_label', '국가'],
        ['tenor_label', '만기'], ['unit', '단위'], ['n_obs', '관측치'],
        ['coverage_pct', '커버리지'], ['n_masked', '보정'],
        ['first_date', '시작'], ['last_date', '종료']
      ];
      var html = '<div class="table-scroll"><table><thead><tr>' +
        cols.map(function (c) {
          return '<th class="sortable" data-key="' + c[0] + '">' + esc(c[1]) +
            (st.sort === c[0] ? (st.dir > 0 ? ' ▲' : ' ▼') : '') + '</th>';
        }).join('') + '</tr></thead><tbody>' +
        rows.map(function (r) {
          var cov = r.coverage_pct;
          var badge = cov >= 90 ? 'ok' : cov >= 50 ? 'warn' : 'crit';
          return '<tr>' +
            '<td>' + esc(r.series_id) + '</td>' +
            '<td>' + esc(r.category) + '</td>' +
            '<td>' + esc(r.country_label) + '</td>' +
            '<td>' + esc(r.tenor_label || '–') + '</td>' +
            '<td>' + esc(unitLabel(r.unit) || r.unit) + '</td>' +
            '<td>' + r.n_obs.toLocaleString() + '</td>' +
            '<td><span class="bar-cell" style="width:' + Math.max(1, cov * 0.44) + 'px"></span> ' +
            '<span class="badge ' + badge + '">' + cov + '%</span></td>' +
            '<td>' + (r.n_masked ? r.n_masked.toLocaleString() : '–') + '</td>' +
            '<td>' + esc(r.first_date || '–') + '</td>' +
            '<td>' + esc(r.last_date || '–') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      this.root.querySelector('#ql-table').innerHTML = html;
      this.root.querySelectorAll('th.sortable').forEach(function (th) {
        th.onclick = function () {
          var key = th.dataset.key;
          if (st.sort === key) { st.dir = -st.dir; } else { st.sort = key; st.dir = 1; }
          self.table();
        };
      });
    }
  };

  function tile(label, value, sub) {
    return '<div class="tile"><div class="label"><span>' + esc(label) +
      '</span></div><div class="value">' + esc(value) +
      '</div><div class="deltas"><span>' + esc(sub) + '</span></div></div>';
  }

  /* ============================ shell ================================ */

  var current = null;

  function show(name) {
    var view = views[name];
    if (!view) return;
    current = name;
    document.querySelectorAll('.tab').forEach(function (t) {
      t.setAttribute('aria-selected', String(t.dataset.view === name));
    });
    document.querySelectorAll('.view').forEach(function (v) {
      v.hidden = v.id !== 'view-' + name;
    });
    try { location.hash = name; } catch (e) { /* file:// can refuse */ }

    var root = document.getElementById('view-' + name);
    if (view.rendered) return;
    root.innerHTML = '<div class="loading">데이터를 불러오는 중…</div>';
    loadCategories(view.needs).then(function () {
      view.rendered = true;
      view.render(root);
    }).catch(function (err) {
      root.innerHTML = '<div class="card"><div class="empty">' +
        esc(err.message) + '</div></div>';
    });
  }

  function initTheme() {
    var stored = null;
    try { stored = localStorage.getItem('md-theme'); } catch (e) { /* blocked */ }
    if (stored) document.documentElement.setAttribute('data-theme', stored);
    var btn = document.getElementById('theme-toggle');
    btn.onclick = function () {
      var root = document.documentElement;
      var isDark = root.getAttribute('data-theme') === 'dark' ||
        (!root.getAttribute('data-theme') &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      var next = isDark ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('md-theme', next); } catch (e) { /* blocked */ }
      // colours are read from CSS variables at paint time, so re-render
      var view = views[current];
      if (view && view.rendered) {
        view.rendered = false;
        show(current);
      }
    };
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var view = views[current];
      if (view && view.rendered) { view.rendered = false; show(current); }
    }, 200);
  });

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('build-info').textContent =
      manifest.n_series + '개 계열 · ' + manifest.first_date + ' ~ ' +
      manifest.last_date + ' · ' + manifest.total_obs.toLocaleString() + '개 관측치';
    document.querySelectorAll('.tab').forEach(function (t) {
      t.onclick = function () { show(t.dataset.view); };
    });
    initTheme();
    var start = (location.hash || '').replace('#', '');
    show(views[start] ? start : 'overview');
  });
})();
