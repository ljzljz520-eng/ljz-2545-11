'use strict';
const L = require('../config').LIMITS;

class ValidationError extends Error {
  constructor(message, details) { super(message); this.name = 'ValidationError'; this.status = 422; this.details = details || null; }
}
class ConflictError extends Error {
  constructor(message, details) { super(message); this.name = 'ConflictError'; this.status = 409; this.details = details || null; }
}
class NotFoundError extends Error {
  constructor(message) { super(message); this.name = 'NotFoundError'; this.status = 404; }
}
class AuthError extends Error {
  constructor(message) { super(message); this.name = 'AuthError'; this.status = 401; }
}

const R = 6371000;
const toRad = (d) => d * Math.PI / 180;

function haversine(a, b) {
  const lng1 = a[0], lat1 = a[1], lng2 = b[0], lat2 = b[1];
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Point P to segment AB distance and projection parameter t (0..1)
function projectPoint(p, a, b) {
  const mLat = 111320;
  const mLng = 111320 * Math.cos(toRad((a[1] + b[1]) / 2));
  const px = (p[0] - a[0]) * mLng, py = (p[1] - a[1]) * mLat;
  const bx = (b[0] - a[0]) * mLng, by = (b[1] - a[1]) * mLat;
  const len2 = bx * bx + by * by;
  let t = len2 === 0 ? 0 : (px * bx + py * by) / len2;
  t = Math.max(0, Math.min(1, t));
  const dx = px - t * bx, dy = py - t * by;
  return { dist: Math.hypot(dx, dy), t };
}

function orient(p1, p2, p3) {
  return (p2[0] - p1[0]) * (p3[1] - p1[1]) - (p2[1] - p1[1]) * (p3[0] - p1[0]);
}
function onBox(p, a, b) {
  return p[0] <= Math.max(a[0], b[0]) + 1e-12 && p[0] >= Math.min(a[0], b[0]) - 1e-12 &&
         p[1] <= Math.max(a[1], b[1]) + 1e-12 && p[1] >= Math.min(a[1], b[1]) - 1e-12;
}
// proper crossing of open segments; touching endpoints is not crossing
function properIntersect(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // collinear overlap
  const onSeg = (q, a, b) => Math.abs(orient(a, b, q)) < 1e-11 && onBox(q, a, b);
  if (Math.abs(d1) < 1e-11 && onSeg(p1, p3, p4)) return true;
  if (Math.abs(d2) < 1e-11 && onSeg(p2, p3, p4)) return true;
  if (Math.abs(d3) < 1e-11 && onSeg(p3, p1, p2)) return true;
  if (Math.abs(d4) < 1e-11 && onSeg(p4, p1, p2)) return true;
  return false;
}

// self-intersection of the polyline; adjacent segments may only share their joint vertex
function findSelfIntersection(coords) {
  const n = coords.length;
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      if (j === i + 1) {
        // adjacent segments share the joint vertex; that is always allowed.
        // flag only a true fold-back: end vertex lies back on the first segment
        // (immediate U-turn overlapping the previous edge).
        if (Math.abs(orient(coords[i], coords[i + 1], coords[j + 1])) < 1e-11 &&
            onBox(coords[j + 1], coords[i], coords[i + 1])) {
          return { segA: i, segB: j };
        }
        continue;
      }
      if (properIntersect(coords[i], coords[i + 1], coords[j], coords[j + 1])) {
        return { segA: i, segB: j };
      }
    }
  }
  return null;
}

// ===== Server-enforced GeoJSON LineString validation =====
function validateLineString(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('geometry must be an object');
  if (input.type !== 'LineString') throw new ValidationError('only GeoJSON LineString accepted', { got: input.type });
  const coords = input.coordinates;
  if (!Array.isArray(coords)) throw new ValidationError('coordinates must be an array');
  if (coords.length < L.MIN_POINTS) throw new ValidationError('polyline needs at least ' + L.MIN_POINTS + ' points');
  if (coords.length > L.MAX_POINTS) throw new ValidationError('polyline exceeds ' + L.MAX_POINTS + ' points (complexity cap)', { points: coords.length });

  const seen = new Set();
  let total = 0;
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    if (!Array.isArray(c) || c.length < 2) throw new ValidationError('coordinate ' + i + ' malformed, expect [lng,lat]');
    const lng = c[0], lat = c[1];
    if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat)) {
      throw new ValidationError('coordinate ' + i + ' is not a finite number');
    }
    if (lng < L.LNG_MIN || lng > L.LNG_MAX || lat < L.LAT_MIN || lat > L.LAT_MAX) {
      throw new ValidationError('coordinate ' + i + ' is out of the server-allowed bounds', { lng, lat });
    }
    for (const v of [lng, lat]) {
      const decimals = String(v).includes('.') ? String(v).split('.')[1].length : 0;
      if (decimals > L.MAX_DECIMALS) throw new ValidationError('coordinate ' + i + ' has more than ' + L.MAX_DECIMALS + ' decimal places');
    }
    const key = lng + ',' + lat;
    if (seen.has(key)) throw new ValidationError('duplicate vertex at index ' + i, { index: i });
    seen.add(key);
    if (i > 0) {
      const d = haversine(coords[i - 1], c);
      if (d < L.MIN_SEGMENT_LEN_M) throw new ValidationError('segment ' + (i - 1) + ' too short (< ' + L.MIN_SEGMENT_LEN_M + 'm)', { segment: i - 1, meters: d });
      if (d > L.MAX_SEGMENT_LEN_M) throw new ValidationError('segment ' + (i - 1) + ' longer than ' + (L.MAX_SEGMENT_LEN_M / 1000) + 'km', { segment: i - 1, meters: d });
      total += d;
    }
  }
  if (total > L.MAX_TOTAL_LEN_M) throw new ValidationError('route longer than ' + (L.MAX_TOTAL_LEN_M / 1000) + 'km', { meters: total });

  const hit = findSelfIntersection(coords);
  if (hit) throw new ValidationError('polyline is self-intersecting; resolve crossings before saving', hit);

  return { geometry: { type: 'LineString', coordinates: coords }, lengthM: Math.round(total) };
}

function validateTextFields(opts) {
  const title = opts.title, story = opts.story;
  if (title === undefined || title === null || String(title).trim().length < L.TITLE_MIN) {
    throw new ValidationError('title needs at least ' + L.TITLE_MIN + ' characters');
  }
  if (String(title).length > L.TITLE_MAX) throw new ValidationError('title longer than ' + L.TITLE_MAX + ' chars');
  if (story !== undefined && story !== null && String(story).length > L.STORY_MAX) {
    throw new ValidationError('story longer than ' + L.STORY_MAX + ' chars');
  }
}

const crypto = require('crypto');
function fingerprintGeometry(geom) {
  return crypto.createHash('sha256').update(JSON.stringify(geom.coordinates)).digest('hex');
}
function fingerprintText(opts) {
  return crypto.createHash('sha256').update(opts.title + ' ' + (opts.story || '')).digest('hex');
}

// Evaluate every stop against a changed geometry; mark those needing relocation
function evaluateStopsAfterGeometry(oldStops, oldCoords, oldUids, newCoords, newUids) {
  return oldStops.map((s) => {
    const anchor = s.anchor;
    if (anchor.kind === 'vertex') {
      const p = newCoords[anchor.seq];
      if (!p) return Object.assign({}, s, { status: 'needs_relocation', anchor: Object.assign({}, anchor, { lost: true }) });
      const drift = haversine(s.coordinates, p);
      if (drift > L.ANCHOR_DRIFT_M) return Object.assign({}, s, { status: 'needs_relocation', coordinates: p });
      return Object.assign({}, s, { coordinates: p, status: 'ok' });
    }
    const newIdx = newUids.indexOf(anchor.uid);
    if (newIdx === -1) {
      let best = null;
      for (let i = 0; i < newUids.length; i++) {
        const pr = projectPoint(s.coordinates, newCoords[i], newCoords[i + 1]);
        if (!best || pr.dist < best.dist) best = { dist: pr.dist, i, t: pr.t };
      }
      const a = newCoords[best.i], b = newCoords[best.i + 1];
      return Object.assign({}, s, {
        status: 'needs_relocation',
        anchor: { kind: 'segment', uid: newUids[best.i], t: best.t, lost: true },
        coordinates: [a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t]
      });
    }
    const a = newCoords[newIdx], b = newCoords[newIdx + 1];
    const pr = projectPoint(s.coordinates, a, b);
    const coordinates = [a[0] + (b[0] - a[0]) * pr.t, a[1] + (b[1] - a[1]) * pr.t];
    const drift = haversine(s.coordinates, coordinates);
    if (drift > L.ANCHOR_DRIFT_M) {
      return Object.assign({}, s, { status: 'needs_relocation', anchor: { kind: 'segment', uid: anchor.uid, t: pr.t }, coordinates });
    }
    return Object.assign({}, s, { status: 'ok', anchor: { kind: 'segment', uid: anchor.uid, t: pr.t }, coordinates });
  });
}

module.exports = {
  ValidationError, ConflictError, NotFoundError, AuthError,
  haversine, projectPoint, validateLineString, validateTextFields,
  fingerprintGeometry, fingerprintText, evaluateStopsAfterGeometry
};
