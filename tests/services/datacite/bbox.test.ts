/**
 * @fileoverview Tests for the `bbox` geometry: the antimeridian split, and whether
 * one deposited location — point, box, or polygon — lies in or intersects a box,
 * on both halves of a box that crosses ±180, in time linear in polygon size.
 * @module tests/services/datacite/bbox.test
 */

import { describe, expect, it } from 'vitest';
import { type Bbox, bboxHalves, type GeoPoint, locationInBbox } from '@/services/datacite/bbox.js';

/** Western Kentucky and Tennessee: lat 36–37, lon -90 to -89. */
const BOX: Bbox = { west: -90, south: 36, east: -89, north: 37 };
/** Around Fiji, across the antimeridian: lon 175 to 180 and -180 to -175. */
const FIJI: Bbox = { west: 175, south: -20, east: -175, north: -15 };

const at = (latitude: number, longitude: number): GeoPoint => ({ latitude, longitude });
/** A closed ring, as DataCite stores a polygon: the first vertex repeated last. */
const ring = (...points: GeoPoint[]) => ({ points: [...points, points[0] as GeoPoint] });

describe('bboxHalves', () => {
  it('keeps a box that does not cross the antimeridian whole', () => {
    expect(bboxHalves(BOX)).toEqual([BOX]);
    expect(bboxHalves({ west: 10, south: 0, east: 10, north: 0 })).toEqual([
      { west: 10, south: 0, east: 10, north: 0 },
    ]);
  });

  it('splits a box whose west lies east of its east at ±180', () => {
    expect(bboxHalves(FIJI)).toEqual([
      { west: 175, south: -20, east: 180, north: -15 },
      { west: -180, south: -20, east: -175, north: -15 },
    ]);
  });
});

describe('locationInBbox', () => {
  describe('points', () => {
    it.each([
      ['inside', at(36.309299, -89.05354), true],
      ['on the north-east corner (edges are inclusive)', at(37, -89), true],
      ['on the south-west corner', at(36, -90), true],
      ['north of the box', at(37.0001, -89.5), false],
      ['west of the box', at(36.5, -90.0001), false],
    ])('a point %s → %s', (_name, point, expected) => {
      expect(locationInBbox({ point }, BOX)).toBe(expected);
    });

    it('rejects each of two points whose latitude and longitude meet the box only across the pair', () => {
      // The latitude of one and the longitude of the other fall in the box; neither point does.
      const chicago = at(41.98939, -89.5);
      const kentucky = at(36.5, -84.75932);
      expect(locationInBbox({ point: chicago }, BOX)).toBe(false);
      expect(locationInBbox({ point: kentucky }, BOX)).toBe(false);
    });

    it.each([
      ['east of ±180', at(-17.7, 178.4), true],
      ['west of ±180', at(-17.7, -178.4), true],
      ['on 180', at(-16, 180), true],
      ['on -180', at(-16, -180), true],
      ['at Greenwich', at(-17.7, 0), false],
      ['between the halves on the far side', at(-17.7, 174.9), false],
    ])(
      'tests a point %s against both halves of an antimeridian box → %s',
      (_n, point, expected) => {
        expect(locationInBbox({ point }, FIJI)).toBe(expected);
      },
    );
  });

  describe('boxes', () => {
    it.each([
      ['overlapping a corner', { west: -89.5, south: 36.5, east: -88, north: 38 }, true],
      ['enclosing it', { west: -177.4, south: -54.9, east: 172.15, north: 79.2 }, true],
      ['inside it', { west: -89.6, south: 36.2, east: -89.4, north: 36.4 }, true],
      ['sharing only its east edge', { west: -89, south: 30, east: -80, north: 40 }, true],
      ['sharing only its west edge', { west: -95, south: 30, east: -90, north: 40 }, true],
      ['sharing only its south edge', { west: -89.8, south: 30, east: -89.2, north: 36 }, true],
      ['sharing only its north edge', { west: -89.8, south: 37, east: -89.2, north: 40 }, true],
      ['east of it', { west: -88.9, south: 36, east: -80, north: 37 }, false],
      ['south of it', { west: -95, south: 20, east: -80, north: 35.9 }, false],
    ])('a deposited box %s → %s', (_name, box, expected) => {
      expect(locationInBbox({ box }, BOX)).toBe(expected);
    });

    it('rejects each half of a region deposited as two boxes split at ±180, though their sides pair across', () => {
      // A depositor's North Pacific: 100° E to 180 and -180 to 100° W, lat 22–75.
      const east = { west: 100, south: 22, east: 180, north: 75 };
      const west = { west: -180, south: 22, east: -100, north: 75 };
      expect(locationInBbox({ box: east }, BOX)).toBe(false);
      expect(locationInBbox({ box: west }, BOX)).toBe(false);
      expect(locationInBbox({ box: west }, { ...BOX, west: -101, east: -100 })).toBe(true);
    });

    it('reads a deposited box whose west lies east of its east as crossing ±180', () => {
      const crossing = { west: 170, south: -30, east: -170, north: 0 };
      expect(
        locationInBbox({ box: crossing }, { west: 172, south: -20, east: 178, north: -10 }),
      ).toBe(true);
      expect(
        locationInBbox({ box: crossing }, { west: -175, south: -20, east: -172, north: -10 }),
      ).toBe(true);
      expect(
        locationInBbox({ box: crossing }, { west: -10, south: -20, east: 10, north: -10 }),
      ).toBe(false);
      expect(locationInBbox({ box: crossing }, FIJI)).toBe(true);
    });

    it('meets an antimeridian box with a box in either half', () => {
      expect(locationInBbox({ box: { west: 176, south: -19, east: 177, north: -18 } }, FIJI)).toBe(
        true,
      );
      expect(
        locationInBbox({ box: { west: -177, south: -19, east: -176, north: -18 } }, FIJI),
      ).toBe(true);
      expect(locationInBbox({ box: { west: -170, south: -19, east: 170, north: -18 } }, FIJI)).toBe(
        false,
      );
    });
  });

  describe('polygons', () => {
    it('accepts a polygon with a vertex inside', () => {
      const polygon = ring(
        at(36.45148, -89.36118),
        at(36.45148, -89.3193),
        at(36.48014, -89.3193),
        at(36.48014, -89.36118),
      );
      expect(locationInBbox({ polygon }, BOX)).toBe(true);
    });

    it('accepts a polygon crossing the box with no vertex inside', () => {
      // A band 2° wide in longitude, 0.2° tall, through the middle of the box.
      const polygon = ring(at(36.4, -91), at(36.4, -88), at(36.6, -88), at(36.6, -91));
      expect(polygon.points.some((p) => locationInBbox({ point: p }, BOX))).toBe(false);
      expect(locationInBbox({ polygon }, BOX)).toBe(true);
    });

    it('accepts a polygon enclosing the box, with no vertex and no edge in it', () => {
      const polygon = ring(at(30, -100), at(30, -80), at(45, -80), at(45, -100));
      expect(locationInBbox({ polygon }, BOX)).toBe(true);
      // The same ring without its closing vertex still encloses it.
      expect(locationInBbox({ polygon: { points: polygon.points.slice(0, -1) } }, BOX)).toBe(true);
    });

    it('rejects a degenerate polygon, one vertex repeated, outside the box', () => {
      const duke = at(36.0, -79.1);
      expect(locationInBbox({ polygon: { points: [duke, duke, duke, duke, duke] } }, BOX)).toBe(
        false,
      );
      const rhinelander = at(45.6, -89.5);
      expect(
        locationInBbox({ polygon: { points: [rhinelander, rhinelander, rhinelander] } }, BOX),
      ).toBe(false);
    });

    it('accepts a degenerate polygon whose one vertex lies inside', () => {
      const inside = at(36.5, -89.5);
      expect(locationInBbox({ polygon: { points: [inside, inside, inside] } }, BOX)).toBe(true);
    });

    it('accepts a triangle touching the box only at its south-west corner, wound either way', () => {
      // Its hypotenuse runs from (35, -89) to (37, -91) through the corner (36, -90).
      expect(locationInBbox({ polygon: ring(at(35, -91), at(35, -89), at(37, -91)) }, BOX)).toBe(
        true,
      );
      expect(locationInBbox({ polygon: ring(at(35, -91), at(37, -91), at(35, -89)) }, BOX)).toBe(
        true,
      );
    });

    it('accepts a polygon sharing only a side with the box, and a degenerate polygon on its west side', () => {
      const southOfIt = ring(at(35, -90), at(35, -89), at(36, -89), at(36, -90));
      expect(locationInBbox({ polygon: southOfIt }, BOX)).toBe(true);
      const onWestSide = at(36.5, -90);
      expect(
        locationInBbox({ polygon: { points: [onWestSide, onWestSide, onWestSide] } }, BOX),
      ).toBe(true);
    });

    it('rejects a polygon wholly east of the box, though the ray from the box corner crosses two of its edges', () => {
      const polygon = ring(at(35, -88), at(35, -87), at(37, -87), at(37, -88));
      expect(locationInBbox({ polygon }, BOX)).toBe(false);
    });

    it('rejects an edge on a line through the box that ends before reaching it', () => {
      // Collinear with the box's diagonal, stopping short of its corner.
      const polygon = ring(at(34, -92), at(35, -91), at(34, -91));
      expect(locationInBbox({ polygon }, BOX)).toBe(false);
    });

    it('rejects a concave polygon whose vertices span the box in latitude and longitude without meeting it', () => {
      // An L wrapping the box's north-west: one arm reaches its latitudes, the other its longitudes.
      const polygon = ring(
        at(36.5, -95),
        at(36.5, -91),
        at(38, -91),
        at(38, -89.5),
        at(39, -89.5),
        at(39, -95),
      );
      expect(locationInBbox({ polygon }, BOX)).toBe(false);
    });

    it('tests a polygon against both halves of an antimeridian box', () => {
      const westOf180 = ring(at(-19, -179), at(-19, -178), at(-18, -178), at(-18, -179));
      const eastOf180 = ring(at(-19, 178), at(-19, 179), at(-18, 179), at(-18, 178));
      const greenwich = ring(at(-19, -1), at(-19, 1), at(-18, 1), at(-18, -1));
      expect(locationInBbox({ polygon: westOf180 }, FIJI)).toBe(true);
      expect(locationInBbox({ polygon: eastOf180 }, FIJI)).toBe(true);
      expect(locationInBbox({ polygon: greenwich }, FIJI)).toBe(false);
    });
  });

  it('accepts a location when any one of its point, box, or polygon meets the box', () => {
    const far = at(10, 10);
    expect(
      locationInBbox(
        {
          point: far,
          box: { west: 0, south: 0, east: 1, north: 1 },
          polygon: ring(at(36.5, -89.5)),
        },
        BOX,
      ),
    ).toBe(true);
    expect(locationInBbox({}, BOX)).toBe(false);
  });

  /**
   * Timeout 0: the body is synchronous, so vitest can't interrupt it and only compares wall time
   * after it returns. Per-call thread CPU stops a super-linear regression; each larger size is
   * paired with a fresh baseline and the least growth of several pairs is kept, since a
   * garbage-collection pause or a slower core only ever adds time.
   */
  it('tests a polygon in thread CPU linear in its vertex count, across 64-fold growth', () => {
    const BASE = 5000;
    const shapes = {
      // Every edge is read: the polygon never meets the box, so nothing ends the pass early.
      'a zig-zag far from the box': (n: number) =>
        Array.from({ length: n }, (_, i) => at(i % 2 === 0 ? 50 : 51, 10 + (10 * i) / n)),
      // Every edge crosses the corner's ray, so each one flips the enclosure parity.
      'a comb across the ray from the box corner': (n: number) =>
        Array.from({ length: n }, (_, i) => at(i % 2 === 0 ? 35 : 37.5, -80 + (10 * i) / n)),
    };
    const perCallMicros = (points: GeoPoint[], calls: number) => {
      const start = process.threadCpuUsage();
      for (let call = 0; call < calls; call++) locationInBbox({ polygon: { points } }, BOX);
      const cpu = process.threadCpuUsage(start);
      return Math.max(1, cpu.user + cpu.system) / calls;
    };
    for (const [shapeName, shape] of Object.entries(shapes)) {
      const base = shape(BASE);
      expect(locationInBbox({ polygon: { points: base } }, BOX)).toBe(false);
      const growth: number[] = [];
      for (let size = BASE * 2; size <= BASE * 64; size *= 2) {
        const points = shape(size);
        let least = Number.POSITIVE_INFINITY;
        for (let pair = 0; pair < 5; pair++) {
          const baseMicros = perCallMicros(base, size / BASE);
          const sizeMicros = perCallMicros(points, 1);
          expect(sizeMicros).toBeLessThan(250_000);
          least = Math.min(least, sizeMicros / baseMicros);
        }
        // Linear growth is size / BASE; the bound allows 4× that before the next size runs.
        expect(least).toBeLessThan((4 * size) / BASE);
        growth.push(Number(least.toFixed(1)));
      }
      expect(growth.at(-1)).toBeLessThan(256);
      console.info('polygon CPU growth', process.versions.bun ? 'Bun' : 'Node', shapeName, growth);
    }
  }, 0);
});
