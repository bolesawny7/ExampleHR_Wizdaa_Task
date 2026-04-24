import { customAlphabet } from 'nanoid';

// URL-safe alphabet without lookalikes; 22 chars ~ 130 bits of entropy.
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghijkmnpqrstuvwxyz';
const nano = customAlphabet(alphabet, 22);

export function newRequestId() {
  return `r_${nano()}`;
}

export function newExternalRequestId() {
  return `ext_${nano()}`;
}

export function newCorrelationId() {
  return `c_${nano()}`;
}
