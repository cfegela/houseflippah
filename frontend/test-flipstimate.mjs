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

// 2. 1 improvement adds +5% to base odds
console.log('2. Testing single improvement (+5% boost)...');
const singleImprovement = {
  improvements: ['windows_doors'],
  is_listed: false,
  purchase_price: 100000,
  market_value: 120000
};
// Ice Cold: 10% + 5% = 15%
assert.equal(calculateFlipstimate(singleImprovement, { market_temperature: 'Ice Cold' }), '15%');
// Chilly: 20% + 5% = 25%
assert.equal(calculateFlipstimate(singleImprovement, { market_temperature: 'Chilly' }), '25%');
// Comfy: 30% + 5% = 35%
assert.equal(calculateFlipstimate(singleImprovement, { market_temperature: 'Comfy' }), '35%');
// Toasty: 40% + 5% = 45%
assert.equal(calculateFlipstimate(singleImprovement, { market_temperature: 'Toasty' }), '45%');
// On Fire: 50% + 5% = 55%
assert.equal(calculateFlipstimate(singleImprovement, { market_temperature: 'On Fire' }), '55%');
console.log('   ✓ Single improvement boosts base odds by +5% (e.g. 50% -> 55% in On Fire).');

// 3. 5 improvements add +25% to base odds
console.log('3. Testing 5 improvements (+25% boost)...');
const fiveImprovements = {
  improvements: ['windows_doors', 'hvac_mechanicals', 'roof_siding', 'flooring_painting', 'kitchen_baths'],
  is_listed: false,
  purchase_price: 100000,
  market_value: 200000
};
// Ice Cold: 10% + 25% = 35%
assert.equal(calculateFlipstimate(fiveImprovements, { market_temperature: 'Ice Cold' }), '35%');
// Chilly: 20% + 25% = 45%
assert.equal(calculateFlipstimate(fiveImprovements, { market_temperature: 'Chilly' }), '45%');
// Comfy: 30% + 25% = 55%
assert.equal(calculateFlipstimate(fiveImprovements, { market_temperature: 'Comfy' }), '55%');
// Toasty: 40% + 25% = 65%
assert.equal(calculateFlipstimate(fiveImprovements, { market_temperature: 'Toasty' }), '65%');
// On Fire: 50% + 25% = 75%
assert.equal(calculateFlipstimate(fiveImprovements, { market_temperature: 'On Fire' }), '75%');
console.log('   ✓ 5 improvements boost base odds by +25% (e.g. 50% -> 75% in On Fire).');

// 4. Properties listed at exact market value
console.log('4. Testing properties listed at exact market value...');
const listedAtMarketSingle = {
  improvements: ['windows_doors'],
  is_listed: true,
  purchase_price: 100000,
  market_value: 120000,
  list_price: 120000
};
assert.equal(calculateFlipstimate(listedAtMarketSingle, { market_temperature: 'On Fire' }), '55%');

const listedAtMarketFive = {
  improvements: ['windows_doors', 'hvac_mechanicals', 'roof_siding', 'flooring_painting', 'kitchen_baths'],
  is_listed: true,
  purchase_price: 100000,
  market_value: 200000,
  list_price: 200000
};
assert.equal(calculateFlipstimate(listedAtMarketFive, { market_temperature: 'On Fire' }), '75%');
console.log('   ✓ Listed at market value equals effective base odds exactly (55% single, 75% five in On Fire).');

// 5. Properties listed below market value (scales with effective base odds)
console.log('5. Testing properties listed below market value...');
// Single improvement in On Fire (55% base odds), discounted 20% ($80k on $100k market value) -> factor = 1.20
// 55% * 1.20 = 66%
const belowMarketSingle = {
  improvements: ['windows_doors'],
  is_listed: true,
  purchase_price: 100000,
  market_value: 100000,
  list_price: 80000
};
assert.equal(calculateFlipstimate(belowMarketSingle, { market_temperature: 'On Fire' }), '66%');
assert.equal(calculateFlipstimate(belowMarketSingle, { market_temperature: 'Comfy' }), '42%'); // 35% * 1.20 = 42%
console.log('   ✓ Pricing below market value boosts effective base odds proportionately.');

// 6. Properties listed above market value (scales with effective base odds)
console.log('6. Testing properties listed above market value...');
// Single improvement in On Fire (55% base odds), marked up 20% ($120k on $100k market value) -> factor = 0.80
// 55% * 0.80 = 44%
const aboveMarketSingle = {
  improvements: ['windows_doors'],
  is_listed: true,
  purchase_price: 100000,
  market_value: 100000,
  list_price: 120000
};
assert.equal(calculateFlipstimate(aboveMarketSingle, { market_temperature: 'On Fire' }), '44%');
assert.equal(calculateFlipstimate(aboveMarketSingle, { market_temperature: 'Comfy' }), '28%'); // 35% * 0.80 = 28%
console.log('   ✓ Pricing above market value decreases effective base odds proportionately.');

// 7. Extreme clamping (never < 0% and never > 100%)
console.log('7. Testing extreme clamping...');
const wayAboveMarket = {
  improvements: ['windows_doors', 'hvac_mechanicals', 'roof_siding', 'flooring_painting', 'kitchen_baths'],
  is_listed: true,
  purchase_price: 100000,
  market_value: 100000,
  list_price: 300000 // 200% over market value -> factor -1.0
};
assert.equal(calculateFlipstimate(wayAboveMarket, { market_temperature: 'On Fire' }), '0%');

const massiveDiscount = {
  improvements: ['windows_doors', 'hvac_mechanicals', 'roof_siding', 'flooring_painting', 'kitchen_baths'],
  is_listed: true,
  purchase_price: 100000,
  market_value: 100000,
  list_price: 10000 // 90% discount -> factor 1.90 -> 75% * 1.90 = 142.5% -> clamped to 100%
};
assert.equal(calculateFlipstimate(massiveDiscount, { market_temperature: 'On Fire' }), '100%');
console.log('   ✓ Clamping strictly bounds odds between 0% and 100%.');

console.log('\n🎉 ALL FLIPSTIMATE UNIT TESTS PASSED PERFECTLY!\n');
