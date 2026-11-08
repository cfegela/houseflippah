// Market Temperature Base Odds
export const MARKET_TEMPERATURE_ODDS = {
  'Ice Cold': 0.10,
  'Chilly': 0.20,
  'Comfy': 0.30,
  'Toasty': 0.40,
  'On Fire': 0.50
};

// Calculate Flipstimate (estimated odds of selling that round)
export function calculateFlipstimate(gp, room) {
  const installedImprovements = Array.isArray(gp?.improvements) ? gp.improvements : [];
  if (installedImprovements.length === 0) {
    return '0%';
  }

  const temp = room?.market_temperature || 'Comfy';
  const baseOdds = MARKET_TEMPERATURE_ODDS[temp] ?? 0.30;

  if (!gp?.is_listed || gp.list_price == null) {
    return `${Math.round(baseOdds * 100)}%`;
  }

  const purchasePrice = gp.purchase_price || 0;
  const marketValue = gp.market_value || purchasePrice;
  if (marketValue <= 0) {
    return `${Math.round(baseOdds * 100)}%`;
  }

  let effectiveOdds = baseOdds * (1.0 - (gp.list_price - marketValue) / marketValue);
  effectiveOdds = Math.max(0, Math.min(1.0, effectiveOdds));
  return `${Math.round(effectiveOdds * 100)}%`;
}
