/* Minimal SVG chart engine -- line charts, sparklines and a heatmap.
   No external dependencies, so the page works offline and from file://.

   Conventions enforced here rather than left to each caller:
     - a single y axis (never two scales on one plot)
     - colour follows the entity, so a series keeps its slot when siblings
       are filtered out
     - hairline solid grid, thin marks, crosshair + tooltip on every plot   */

(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var SERIES_SLOTS = 8;

  function el(name, attrs) {
    var node = document.createElementNS(NS, name);
    for (var k in attrs) {
      if (attrs[k] !== null && attrs[k] !== undefined) {
        node.setAttribute(k, attrs[k]);
      }
    }
    return node;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(name).trim();
  }

  /* Colour follows the entity: the slot index is passed in by the caller and
     never derived from position in the current filter. */
  function seriesColor(slot) {
    return cssVar('--series-' + ((slot % SERIES_SLOTS) + 1));
  }

  /* ----------------------------------------------------------- scales */

  function niceTicks(min, max, target) {
    if (!isFinite(min) || !isFinite(max)) return { ticks: [0, 1], min: 0, max: 1 };
    if (min === max) { min -= 0.5; max += 0.5; }
    var raw = (max - min) / Math.max(2, target);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm >= 5 ? 10 : norm >= 2.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
    var lo = Math.floor(min / step) * step;
    var hi = Math.ceil(max / step) * step;
    var ticks = [];
    for (var v = lo; v <= hi + step * 0.5; v += step) {
      ticks.push(Math.abs(v) < step * 1e-9 ? 0 : +v.toFixed(10));
    }
    return { ticks: ticks, min: lo, max: hi, step: step };
  }

  function fmtValue(v, unit, digits) {
    if (v === null || v === undefined || !isFinite(v)) return '–';
    if (digits === undefined) {
      digits = (unit === 'krw' || unit === 'index') ? 2
        : unit === 'bp' ? 0
          : unit === 'fx' ? 4 : 3;
    }
    return v.toLocaleString('en-US', {
      minimumFractionDigits: digits, maximumFractionDigits: digits
    });
  }

  function unitSuffix(unit) {
    return unit === 'percent' ? '%' : unit === 'bp' ? 'bp' : '';
  }

  /* ------------------------------------------------------- line chart */

  /* config:
       series:  [{ key, label, slot, values: [n|null], unit }]
       x:       { labels: [...], type: 'date'|'ordinal', title }
       height, yTitle, yZeroLine, digits, onPoint                          */
  function LineChart(container, config) {
    this.container = container;
    this.config = config;
    this.hoverIndex = null;
    container.classList.add('chart-wrap');
    container.innerHTML = '';
    this.svg = el('svg');
    container.appendChild(this.svg);
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'tooltip';
    this.tooltip.hidden = true;
    container.appendChild(this.tooltip);
    this._bind();
    this.render();
  }

  LineChart.prototype._bind = function () {
    var self = this;
    this._onMove = function (ev) { self._hover(ev); };
    this._onLeave = function () { self._clearHover(); };
    this.svg.addEventListener('mousemove', this._onMove);
    this.svg.addEventListener('mouseleave', this._onLeave);
    this.svg.addEventListener('touchmove', function (ev) {
      if (ev.touches.length === 1) { self._hover(ev.touches[0]); }
    }, { passive: true });
    this.svg.addEventListener('touchend', this._onLeave);
  };

  LineChart.prototype.update = function (config) {
    this.config = config;
    this.hoverIndex = null;
    this.render();
  };

  LineChart.prototype.render = function () {
    var cfg = this.config;
    var series = cfg.series || [];
    var labels = (cfg.x && cfg.x.labels) || [];
    var width = Math.max(320, this.container.clientWidth || 720);
    var height = cfg.height || 320;
    // The x-axis band is inside the height, so the card never grows a nested
    // scrollbar just to show tick labels. Endpoint labels sit in the right
    // gutter rather than on top of the line, so it widens when they are on.
    var wantLabels = cfg.directLabels !== false && series.length <= 4;
    var pad = { top: 12, right: wantLabels ? 54 : 16, bottom: 34, left: 56 };

    this.svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    this.svg.setAttribute('height', height);
    this.svg.innerHTML = '';

    var plotW = width - pad.left - pad.right;
    var plotH = height - pad.top - pad.bottom;
    if (plotW <= 0 || plotH <= 0 || !labels.length) return;

    var min = Infinity, max = -Infinity, any = false;
    series.forEach(function (s) {
      s.values.forEach(function (v) {
        if (v === null || v === undefined || !isFinite(v)) return;
        any = true;
        if (v < min) min = v;
        if (v > max) max = v;
      });
    });
    if (!any) {
      this.svg.appendChild(el('rect', { width: width, height: height, fill: 'none' }));
      var msg = el('text', {
        x: width / 2, y: height / 2, 'text-anchor': 'middle',
        fill: cssVar('--text-muted'), 'font-size': 13
      });
      msg.textContent = '선택한 구간에 데이터가 없습니다';
      this.svg.appendChild(msg);
      return;
    }

    var padY = (max - min) * 0.08 || Math.abs(max || 1) * 0.08;
    var scale = niceTicks(min - padY, max + padY, 5);
    var y0 = scale.min, y1 = scale.max;
    var xOf = labels.length === 1
      ? function () { return pad.left + plotW / 2; }
      : function (i) { return pad.left + (i / (labels.length - 1)) * plotW; };
    var yOf = function (v) {
      return pad.top + plotH - ((v - y0) / (y1 - y0)) * plotH;
    };
    this._xOf = xOf; this._plot = { pad: pad, w: plotW, h: plotH };

    var gridColor = cssVar('--grid');
    var axisColor = cssVar('--axis');
    var mutedColor = cssVar('--text-muted');

    // horizontal gridlines -- solid hairlines, one shade off the surface
    scale.ticks.forEach(function (t) {
      if (t < y0 - 1e-9 || t > y1 + 1e-9) return;
      var y = yOf(t);
      this.svg.appendChild(el('line', {
        x1: pad.left, x2: pad.left + plotW, y1: y, y2: y,
        stroke: gridColor, 'stroke-width': 1
      }));
      var label = el('text', {
        x: pad.left - 8, y: y + 3.5, 'text-anchor': 'end',
        fill: mutedColor, 'font-size': 11
      });
      label.textContent = fmtValue(t, cfg.unit, cfg.tickDigits);
      this.svg.appendChild(label);
    }, this);

    // zero line reads as a reference, so it is inked a step darker
    if (cfg.yZeroLine !== false && y0 < 0 && y1 > 0) {
      this.svg.appendChild(el('line', {
        x1: pad.left, x2: pad.left + plotW, y1: yOf(0), y2: yOf(0),
        stroke: axisColor, 'stroke-width': 1
      }));
    }

    // x ticks: year boundaries for dates, evenly thinned for ordinal axes
    var xTicks = this._xTickIndices(labels, cfg.x.type, plotW);
    xTicks.forEach(function (i) {
      var x = xOf(i);
      this.svg.appendChild(el('line', {
        x1: x, x2: x, y1: pad.top, y2: pad.top + plotH,
        stroke: gridColor, 'stroke-width': 1
      }));
      var t = el('text', {
        x: x, y: pad.top + plotH + 17, 'text-anchor': 'middle',
        fill: mutedColor, 'font-size': 11
      });
      t.textContent = cfg.x.type === 'date'
        ? String(labels[i]).slice(0, 4) : labels[i];
      this.svg.appendChild(t);
    }, this);

    this.svg.appendChild(el('line', {
      x1: pad.left, x2: pad.left + plotW,
      y1: pad.top + plotH, y2: pad.top + plotH,
      stroke: axisColor, 'stroke-width': 1
    }));

    // series paths -- 2px, gaps break the path rather than interpolating
    series.forEach(function (s) {
      var d = '', pen = false, last = null;
      s.values.forEach(function (v, i) {
        if (v === null || v === undefined || !isFinite(v)) { pen = false; return; }
        var cmd = pen ? 'L' : 'M';
        d += cmd + xOf(i).toFixed(1) + ' ' + yOf(v).toFixed(1);
        pen = true; last = { i: i, v: v };
      });
      if (d) {
        this.svg.appendChild(el('path', {
          d: d, fill: 'none', stroke: seriesColor(s.slot),
          'stroke-width': 2, 'stroke-linejoin': 'round',
          'stroke-linecap': 'round'
        }));
      }
      // a single visible point still needs a mark
      if (last && s.values.filter(function (v) { return v !== null; }).length === 1) {
        this.svg.appendChild(el('circle', {
          cx: xOf(last.i), cy: yOf(last.v), r: 3.5,
          fill: seriesColor(s.slot)
        }));
      }
      s._last = last;
    }, this);

    // Selective direct labels: the endpoint only, never a value on every
    // point. Labels are pushed apart vertically so close endpoints stay
    // readable instead of overprinting each other.
    if (wantLabels) {
      var marks = [];
      series.forEach(function (s) {
        if (!s._last) return;
        marks.push({
          y: yOf(s._last.v), slot: s.slot,
          text: fmtValue(s._last.v, s.unit || cfg.unit, cfg.digits)
        });
      });
      marks.sort(function (a, b) { return a.y - b.y; });
      var gap = 13;
      for (var m = 1; m < marks.length; m++) {
        if (marks[m].y - marks[m - 1].y < gap) {
          marks[m].y = marks[m - 1].y + gap;
        }
      }
      var overflow = marks.length
        ? marks[marks.length - 1].y - (pad.top + plotH) : 0;
      if (overflow > 0) {
        marks.forEach(function (mk) { mk.y -= overflow; });
      }
      marks.forEach(function (mk) {
        var t = el('text', {
          x: pad.left + plotW + 6, y: Math.max(pad.top + 4, mk.y) + 3.5,
          'text-anchor': 'start', fill: seriesColor(mk.slot),
          'font-size': 11, 'font-weight': 600
        });
        t.textContent = mk.text;
        this.svg.appendChild(t);
      }, this);
    }

    this._hoverLayer = el('g', {});
    this.svg.appendChild(this._hoverLayer);
    this._yOf = yOf;
    this._series = series;
    this._labels = labels;
  };

  LineChart.prototype._xTickIndices = function (labels, type, plotW) {
    var out = [];
    if (type === 'date') {
      var lastYear = null;
      for (var i = 0; i < labels.length; i++) {
        var year = String(labels[i]).slice(0, 4);
        if (year !== lastYear) { out.push(i); lastYear = year; }
      }
      var maxTicks = Math.max(2, Math.floor(plotW / 62));
      if (out.length > maxTicks) {
        var stride = Math.ceil(out.length / maxTicks);
        out = out.filter(function (_, k) { return k % stride === 0; });
      }
    } else {
      var limit = Math.max(2, Math.floor(plotW / 46));
      var step = Math.max(1, Math.ceil(labels.length / limit));
      for (var j = 0; j < labels.length; j += step) out.push(j);
      if (out[out.length - 1] !== labels.length - 1) out.push(labels.length - 1);
    }
    return out;
  };

  LineChart.prototype._indexFromEvent = function (ev) {
    var rect = this.svg.getBoundingClientRect();
    var scaleX = rect.width / (this.svg.viewBox.baseVal.width || rect.width);
    var x = (ev.clientX - rect.left) / scaleX;
    var p = this._plot;
    var n = this._labels.length;
    if (n < 2) return 0;
    var ratio = (x - p.pad.left) / p.w;
    return Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1))));
  };

  LineChart.prototype._hover = function (ev) {
    if (!this._plot || !this._labels || !this._labels.length) return;
    var i = this._indexFromEvent(ev);
    if (i === this.hoverIndex) { this._positionTooltip(ev); return; }
    this.hoverIndex = i;
    var cfg = this.config;
    var p = this._plot;
    var x = this._xOf(i);

    this._hoverLayer.innerHTML = '';
    this._hoverLayer.appendChild(el('line', {
      x1: x, x2: x, y1: p.pad.top, y2: p.pad.top + p.h,
      stroke: cssVar('--axis'), 'stroke-width': 1
    }));

    var rows = [];
    this._series.forEach(function (s) {
      var v = s.values[i];
      if (v === null || v === undefined || !isFinite(v)) return;
      rows.push({ s: s, v: v });
      // 2px surface ring keeps overlapping markers separable
      this._hoverLayer.appendChild(el('circle', {
        cx: x, cy: this._yOf(v), r: 4.5,
        fill: seriesColor(s.slot), stroke: cssVar('--surface'),
        'stroke-width': 2
      }));
    }, this);

    if (!rows.length) { this.tooltip.hidden = true; return; }
    rows.sort(function (a, b) { return b.v - a.v; });

    var html = '<div class="tt-date">' + escapeHtml(String(this._labels[i])) +
      (cfg.x.type === 'ordinal' && cfg.x.title ? ' · ' + escapeHtml(cfg.x.title) : '') +
      '</div>';
    rows.forEach(function (r) {
      html += '<div class="tt-row"><span class="name">' +
        '<span class="swatch" style="background:' + seriesColor(r.s.slot) + '"></span>' +
        escapeHtml(r.s.label) + '</span><span class="num">' +
        fmtValue(r.v, r.s.unit || cfg.unit, cfg.digits) +
        unitSuffix(r.s.unit || cfg.unit) + '</span></div>';
    });
    this.tooltip.innerHTML = html;
    this.tooltip.hidden = false;
    this._positionTooltip(ev);
    if (cfg.onPoint) cfg.onPoint(i);
  };

  LineChart.prototype._positionTooltip = function (ev) {
    var box = this.container.getBoundingClientRect();
    var tip = this.tooltip.getBoundingClientRect();
    var x = ev.clientX - box.left + 14;
    var y = ev.clientY - box.top + 12;
    if (x + tip.width > box.width) x = ev.clientX - box.left - tip.width - 14;
    if (y + tip.height > box.height) y = Math.max(0, box.height - tip.height - 4);
    this.tooltip.style.left = Math.max(0, x) + 'px';
    this.tooltip.style.top = Math.max(0, y) + 'px';
  };

  LineChart.prototype._clearHover = function () {
    this.hoverIndex = null;
    if (this._hoverLayer) this._hoverLayer.innerHTML = '';
    this.tooltip.hidden = true;
  };

  LineChart.prototype.destroy = function () {
    this.svg.removeEventListener('mousemove', this._onMove);
    this.svg.removeEventListener('mouseleave', this._onLeave);
  };

  /* -------------------------------------------------------- sparkline */

  function sparkline(container, values, slot) {
    container.innerHTML = '';
    var clean = values.filter(function (v) { return v !== null && isFinite(v); });
    if (clean.length < 2) return;
    var w = Math.max(60, container.clientWidth || 160), h = 30;
    var min = Math.min.apply(null, clean), max = Math.max.apply(null, clean);
    if (min === max) { min -= 0.5; max += 0.5; }
    var svg = el('svg', { viewBox: '0 0 ' + w + ' ' + h, height: h });
    var d = '', pen = false;
    values.forEach(function (v, i) {
      if (v === null || !isFinite(v)) { pen = false; return; }
      var x = (i / (values.length - 1)) * (w - 2) + 1;
      var y = h - 3 - ((v - min) / (max - min)) * (h - 6);
      d += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
      pen = true;
    });
    svg.appendChild(el('path', {
      d: d, fill: 'none', stroke: seriesColor(slot || 0),
      'stroke-width': 1.5, 'stroke-linejoin': 'round'
    }));
    container.appendChild(svg);
  }

  /* ---------------------------------------------------------- heatmap */

  /* Sequential magnitude: one hue, light -> dark. Cells carry their value as
     text, so colour is never the only channel. */
  function heatmap(container, config) {
    var rows = config.rows, cols = config.cols, valueAt = config.valueAt;
    container.innerHTML = '';
    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    hr.appendChild(document.createElement('th')).textContent = config.corner || '';
    cols.forEach(function (c) {
      var th = document.createElement('th');
      th.textContent = c.label;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var values = [];
    rows.forEach(function (r) {
      cols.forEach(function (c) {
        var v = valueAt(r, c);
        if (v !== null && v !== undefined && isFinite(v)) values.push(v);
      });
    });
    var lo = values.length ? Math.min.apply(null, values) : 0;
    var hi = values.length ? Math.max.apply(null, values) : 1;
    if (lo === hi) hi = lo + 1;

    var steps = ['--seq-100', '--seq-200', '--seq-300', '--seq-400',
      '--seq-500', '--seq-600', '--seq-700'];
    function stepFor(v) {
      var t = (v - lo) / (hi - lo);
      return Math.max(0, Math.min(steps.length - 1,
        Math.floor(t * steps.length)));
    }

    var tbody = document.createElement('tbody');
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      var th = document.createElement('th');
      th.textContent = r.label;
      th.style.textAlign = 'left';
      th.style.position = 'static';
      tr.appendChild(th);
      cols.forEach(function (c) {
        var td = document.createElement('td');
        var v = valueAt(r, c);
        if (v === null || v === undefined || !isFinite(v)) {
          td.textContent = '–';
          td.style.color = cssVar('--text-muted');
        } else {
          var fill = cssVar(steps[stepFor(v)]);
          td.textContent = fmtValue(v, config.unit, config.digits);
          td.style.background = fill;
          // 2px surface gap between fills, never a border around the mark
          td.style.boxShadow = 'inset 0 0 0 2px ' + cssVar('--surface');
          td.style.color = readableInk(fill);
          td.style.fontWeight = '600';
          td.title = r.label + ' · ' + c.label + ' = ' +
            fmtValue(v, config.unit, config.digits) + unitSuffix(config.unit);
          if (config.onCell) {
            td.style.cursor = 'pointer';
            td.addEventListener('click', function () { config.onCell(r, c, v); });
          }
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
    return { min: lo, max: hi };
  }

  /* Pick black or white ink by measured luminance of the cell fill. The
     sequential ramp runs light->dark in light mode and dark->light in dark
     mode, so choosing ink from the ramp index instead would leave white text
     on the palest cells of one of the two themes. */
  function readableInk(background) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(background).trim());
    if (!m) return cssVar('--text-primary');
    var n = parseInt(m[1], 16);
    var channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (c) {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    var L = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    var againstWhite = 1.05 / (L + 0.05);
    var againstBlack = (L + 0.05) / 0.05;
    return againstWhite >= againstBlack ? '#ffffff' : '#0b0b0b';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  global.Charts = {
    LineChart: LineChart,
    sparkline: sparkline,
    heatmap: heatmap,
    seriesColor: seriesColor,
    fmtValue: fmtValue,
    unitSuffix: unitSuffix,
    niceTicks: niceTicks,
    escapeHtml: escapeHtml,
    SERIES_SLOTS: SERIES_SLOTS
  };
})(window);
