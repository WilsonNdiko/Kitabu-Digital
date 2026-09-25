/**
 * Test helpers — a bootstrapped in-memory Kitabu with a ManualClock.
 * Not a test file (does not match *.test.ts).
 */

import { openKitabuInMemory } from '../src/node.ts';
import { ManualClock } from '../src/foundation/clock.ts';
import type { Kitabu } from '../src/kitabu.ts';

export interface TestSetup {
  kitabu: Kitabu;
  clock: ManualClock;
}

export function newKitabu(startAt: string = '2026-09-01T09:00:00.000Z'): TestSetup {
  const clock = new ManualClock(startAt);
  const kitabu = openKitabuInMemory({ clock });
  kitabu.bootstrap({
    organizationName: 'Wilson Properties',
    landlordName: 'Wilson Ndiko',
    deviceName: 'Test Laptop',
    platform: 'WINDOWS',
    unitTerm: 'House',
  });
  return { kitabu, clock };
}

/** Green View Apartments fixture: 1 property, 3 houses (A-11, A-12, B-04). */
export interface GreenView {
  propertyId: string;
  units: { a11: string; a12: string; b04: string };
}

export function setupGreenView(kitabu: Kitabu): GreenView {
  const property = kitabu.services.property.createProperty({
    name: 'Green View Apartments',
    town: 'Nairobi',
    estate: 'Kasarani',
  });
  const a11 = kitabu.services.property.addUnit({ propertyId: property.id, label: 'A-11' });
  const a12 = kitabu.services.property.addUnit({ propertyId: property.id, label: 'A-12' });
  const b04 = kitabu.services.property.addUnit({ propertyId: property.id, label: 'B-04' });
  return { propertyId: property.id, units: { a11: a11.id, a12: a12.id, b04: b04.id } };
}
