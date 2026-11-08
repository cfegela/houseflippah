import assert from 'node:assert/strict';
import { calculateFlipstimate, MARKET_TEMPERATURE_ODDS } from './src/odds.js';

console.log('🧪 Starting Flipstimate Odds Calculation Unit Tests...\n');

// 1. Unimproved properties should ALWAYS show 0%
console.log('1. Testing unimproved properties return 0%...');
assert.equal(calculateFlipstimate({ improvements: [] }, { market_temperature: 'On Fire' }), '0%');
assert.equal(calculateFlipstimate({ improvements: null }, { market_temperature: 'Toasty' }), '0%');
assert.equal(calculateFlipstimate({}, { market_temperature: 'Comfy' }), '0%');
assert.equal(calculateFlipstimate(null, { market_temperature: 'Ice Cold' }), '0%');
console.log('   ✓ Unimproved properties return 0% across all market temperatures.');

// 2. Improved unlisted properties return base odds for round
console.log('2. Testing improved unlisted properties return round base odds...');
const improvedUnlisted = { improvements: ['windows_doors'], is_listed: false, purchase_price: 100000, market_value: 120000 };
assert.equal(calculateFlipstimate(improvedUnlisted, { market_temperature: 'Ice Cold' }), '10%');
assert.equal(calculateFlipstimate(improvedUnlisted, { market_temperature: 'Chilly' }), '20%');
assert.equal(calculateFlipstimate(improvedUnlisted, { market_temperature: 'Comfy' }), '30%');
assert.equal(calculateFlipstimate(improvedUnlisted, { market_temperature: 'Toasty' }), '40%');
assert.equal(calculateFlipstimate(improvedUnlisted, { market_temperature: 'On Fire' }), '50%');
assert.equal(calculateFlipstimate(improvedUnlisted, null), '30%'); // Default Comfy
console.log('   ✓ Unlisted improved properties match round base odds perfectly (10%, 20%, 30%, 40%, 50%).');

// 3. Improved properties listed at exact market value
console.log('3. Testing properties listed at exact market value...');
const listedAtMarket = {
  improvements: ['windows_doors'],
  is_listed: true,
  purchase_price: 100000,
  market_value: 120000,
  list_price: 120000
};
assert.equal(calculateFlipstimate(listedAtMarket, { market_temperature: 'Ice Cold' }), '10%');
assert.equal(calculateFlipstimate(listedAtMarket, { market_temperature: 'Chilly' }), '20%');
assert.equal(calculateFlipstimate(listedAtMarket, { market_temperature: 'Comfy' }), '30%');
assert.equal(calculateFlipstimate(listedAtMarket, { market_temperature: 'Toasty' }), '40%');
assert.equal(calculateFlipstimate(listedAtMarket, { market_temperature: 'On Fire' }), '50%');
console.log('   ✓ Listed at market value equals base odds exactly.');

// 4. Properties listed below market value (boosts odds)
console.log('4. Testing properties listed below market value...');
// 20% below market value ($80k on $100k market value) -> factor = 1.20
const belowMarket = {
  improvements: ['windows_doors'],
  is_listed: true,
  purchase_price: 100000,
  market_value: 100000,
  list_price: 80000
};
// Comfy: 30% * 1.20 = 36%
assert.equal(calculateFlipstimate(belowMarket, { market_temperature: 'Comfy' }), '36%');
// On Fire: 50% * 1.20 = 60%
assert.equal(calculateFlipstimate(belowMarket, { market_temperature: 'On Fire' }), '60%');
// Ice Cold: 10% * 1.20 = 12%
assert.equal(calculateFlipstimate(belowMarket, { market_temperature: 'Ice Cold' }), '12%');
console.log('   ✓ Pricing below market value increases odds proportionately.');

// 5. Properties listed above market value (reduces odds)
console.log('5. Testing properties listed above market value...');
// 20% above market value ($120k on $100k market value) -> factor = 0.80
const aboveMarket = {
  improvements: ['windows_doors'],
  is_listed: true,
  purchase_price: 100000,
  market_value: 100000,
  list_price: 120000
};
// Comfy: 30% * 0.80 = 24%
assert.equal(calculateFlipstimate(aboveMarket, { market_temperature: 'Comfy' }), '24%');
// On Fire: 50% * 0.80 = 40%
assert.equal(calculateFlipstimate(aboveMarket, { market_temperature: 'On Fire' }), '40%');
// Ice Cold: 10% * 0.80 = 8%
assert.equal(calculateFlipstimate(aboveMarket, { market_temperature: 'Ice Cold' }), '8%');
console.log('   ✓ Pricing above market value decreases odds proportionately.');

// 6. Extreme clamping (never < 0% and never > 100%)
console.log('6. Testing extreme clamping...');
const wayAboveMarket = {
  improvements: ['windows_doors'],
  is_listed: true,
  purchase_price: 100000,
  market_value: 100000,
  list_price: 300000 // 200% over market value -> factor -1.0
};
assert.equal(calculateFlipstimate(wayAboveMarket, { market_temperature: 'On Fire' }), '0%');

const massiveDiscount = {
  improvements: ['windows_doors'],
  is_listed: true,
  purchase_price: 100000,
  market_value: 100000,
  list_price: 1 // essentially free -> factor 2.0
};
assert.equal(calculateFlipstimate(massiveDiscount, { market_temperature: 'On Fire' }), '100%');
console.log('   ✓ Clamping strictly bounds odds between 0% and 100%.');

console.log('\n🎉 ALL FLIPSTIMATE UNIT TESTS PASSED PERFECTLY!\n');
