/**
 * @fileoverview Bounding-box geometry for the `bbox` filter of
 * `datacite_search_works`: a box split where it crosses the antimeridian, and
 * whether one deposited location — its point, box, or polygon, as the mappers
 * parse them — lies in or intersects a box. Longitude and latitude are treated
 * as a plane in decimal degrees, and every edge is inclusive, as DataCite's range
 * queries are.
 * @module services/datacite/bbox
 */

/** A box in decimal degrees. `west` greater than `east` crosses the antimeridian. */
export interface Bbox {
  east: number;
  north: number;
  south: number;
  west: number;
}

/** A position in decimal degrees. */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** The parsed geometry of one deposited location; a place name alone has none. */
export interface LocationGeometry {
  box?: Bbox;
  point?: GeoPoint;
  polygon?: { points: readonly GeoPoint[] };
}

/** `box` as boxes that do not cross the antimeridian: itself, or its parts east and west of ±180. */
export const bboxHalves = (box: Bbox): Bbox[] =>
  box.west <= box.east
    ? [box]
    : [
        { ...box, east: 180 },
        { ...box, west: -180 },
      ];

const pointInBox = (point: GeoPoint, box: Bbox): boolean =>
  point.latitude >= box.south &&
  point.latitude <= box.north &&
  point.longitude >= box.west &&
  point.longitude <= box.east;

/** Bounds overlap, side against side as the box clause compares them upstream. */
const boxesIntersect = (a: Bbox, b: Bbox): boolean =>
  a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;

/** Whether the segment from `a` to `c` touches `box` (Liang–Barsky clipping), so no collinear point outside it counts. */
function segmentTouchesBox(a: GeoPoint, c: GeoPoint, box: Bbox): boolean {
  const dx = c.longitude - a.longitude;
  const dy = c.latitude - a.latitude;
  const sides = [
    [-dx, a.longitude - box.west],
    [dx, box.east - a.longitude],
    [-dy, a.latitude - box.south],
    [dy, box.north - a.latitude],
  ] as const;
  let enter = 0;
  let leave = 1;
  for (const [direction, distance] of sides) {
    if (direction === 0) {
      if (distance < 0) return false;
      continue;
    }
    const t = distance / direction;
    if (direction < 0) {
      if (t > leave) return false;
      if (t > enter) enter = t;
    } else {
      if (t < enter) return false;
      if (t < leave) leave = t;
    }
  }
  return true;
}

/**
 * Whether a polygon and a box share a point, in one pass over its edges: an edge
 * touching the box (a vertex inside it included) intersects; failing that, the
 * box lies wholly inside the polygon or wholly outside, which one corner decides
 * by ray casting. A degenerate polygon — one vertex repeated — counts as that point.
 */
function polygonIntersectsBox(points: readonly GeoPoint[], box: Bbox): boolean {
  let cornerInside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const from = points[j] as GeoPoint;
    const to = points[i] as GeoPoint;
    if (segmentTouchesBox(from, to, box)) return true;
    if (
      to.latitude > box.south !== from.latitude > box.south &&
      box.west <
        ((from.longitude - to.longitude) * (box.south - to.latitude)) /
          (from.latitude - to.latitude) +
          to.longitude
    ) {
      cornerInside = !cornerInside;
    }
  }
  return cornerInside;
}

/**
 * Whether one deposited location lies in or intersects `bbox`: its point inside,
 * its box overlapping, or its polygon sharing a point with it. Both `bbox` and a
 * deposited box are tested half by half where they cross the antimeridian.
 */
export function locationInBbox(location: LocationGeometry, bbox: Bbox): boolean {
  const { point, box, polygon } = location;
  return bboxHalves(bbox).some(
    (half) =>
      (point !== undefined && pointInBox(point, half)) ||
      (box !== undefined && bboxHalves(box).some((part) => boxesIntersect(part, half))) ||
      (polygon !== undefined && polygonIntersectsBox(polygon.points, half)),
  );
}
