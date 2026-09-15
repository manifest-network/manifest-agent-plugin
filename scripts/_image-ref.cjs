'use strict';

// Local syntax classification only: no registry lookup, normalization, or
// assertion that a supplied digest exists. Shared by draft saving and the
// check-image-references CLI. Full manifest validation remains upstream.
const { normalizeServices } = require('./_spec.cjs');
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;

function digestStatus(ref) {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new Error('image reference must be a non-empty string');
  }
  const at = ref.indexOf('@');
  if (at === -1) {
    if (/\s|\p{C}/u.test(ref)) throw new Error('image reference contains whitespace or control characters');
    return 'tag';
  }
  // Exactly one @, a non-empty repository part, and the supported lowercase
  // SHA-256 form. A tag before @ and a registry port are preserved verbatim.
  return at > 0 && !/\s|\p{C}/u.test(ref) && OCI_DIGEST.test(ref.slice(at + 1))
    ? 'digest' : 'malformed-digest';
}

function checkImageReferences(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('spec must be a JSON object');
  }
  const hasImage = Object.hasOwn(spec, 'image');
  const hasServices = Object.hasOwn(spec, 'services');
  if (hasImage === hasServices) throw new Error('spec must contain exactly one of image or services');
  if (hasServices && (!spec.services || typeof spec.services !== 'object' ||
      Array.isArray(spec.services) || Object.keys(spec.services).length === 0)) {
    throw new Error('services must be a non-empty object');
  }
  const images = normalizeServices(spec).map(({ name, raw }) => {
    const image = raw.image;
    const status = digestStatus(image);
    return { service: name, image, status };
  });
  return { valid: images.every(({ status }) => status !== 'malformed-digest'), images };
}

module.exports = { digestStatus, checkImageReferences };
