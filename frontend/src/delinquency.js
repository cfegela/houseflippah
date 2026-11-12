/**
 * Return delinquent properties owned by the user that require payment this round to stave off foreclosure.
 * Excludes properties that have been sold (e.g. to automated buyers) or whose mortgages are cleared.
 *
 * @param {string} userId - ID of the user to check
 * @param {Array} gameProps - Game properties list
 * @param {number} currentRound - Current active round number
 * @param {Array} propertySales - Property sales history list (optional)
 * @returns {Array} List of delinquent game properties requiring payment
 */
export function getDelinquentProperties(userId, gameProps = [], currentRound = 1, propertySales = []) {
  if (!userId || !Array.isArray(gameProps)) return [];

  // Track any properties sold by the user during the transition to the current round
  const soldSlugs = new Set();
  if (Array.isArray(propertySales)) {
    const previousRound = (Number(currentRound) || 1) - 1;
    propertySales.forEach((s) => {
      if (
        s.seller_user_id === userId &&
        (s.round_number === previousRound || s.round_number === Number(currentRound))
      ) {
        soldSlugs.add(s.property_slug);
      }
    });
  }

  return gameProps.filter((gp) => {
    if (gp.owner_user_id !== userId) return false;
    // Sold to automated buyer: deed surrendered and mortgage cleared
    if (gp.is_sold_to_buyer) return false;
    // Mortgage cleared or paid off: no outstanding mortgage balance
    if (gp.mortgage_balance !== undefined && Number(gp.mortgage_balance || 0) <= 0) return false;
    // Sold during recent automated buying round transition
    if (soldSlugs.has(gp.property_slug)) return false;

    const missed = Number(gp.missed_payments || 0);
    const lastPaid = Number(gp.last_paid_round || 0);
    return missed >= 1 && lastPaid < currentRound;
  });
}
