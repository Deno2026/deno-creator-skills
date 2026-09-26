#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const {
  isValidGeneratedDescription,
  sameLocalizationDescription,
} = require("../tools/lib/youtube_metadata_backfill_policy.cjs");

assert.equal(isValidGeneratedDescription("", ""), true);
assert.equal(isValidGeneratedDescription("", "Invented description"), false);
assert.equal(isValidGeneratedDescription("", "   "), false);
assert.equal(isValidGeneratedDescription("원본 설명", ""), false);
assert.equal(isValidGeneratedDescription("원본 설명", "Localized description"), true);
assert.equal(isValidGeneratedDescription("원본 설명", "x".repeat(5001)), false);
assert.equal(isValidGeneratedDescription(null, ""), false);
assert.equal(isValidGeneratedDescription("", null), false);

assert.equal(sameLocalizationDescription("", ""), true);
assert.equal(sameLocalizationDescription(undefined, ""), true);
assert.equal(sameLocalizationDescription(null, ""), true);
assert.equal(sameLocalizationDescription("Changed", ""), false);
assert.equal(sameLocalizationDescription(0, ""), false);

process.stdout.write("YOUTUBE_METADATA_BACKFILL_POLICY_OK\n");
