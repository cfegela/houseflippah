/**
 * Determine if a player owns any properties that can currently be improved.
 * Properties cannot be improved in the round they were purchased, if actively listed/delisted this round,
 * or if already max upgraded (5/5).
 *
 * @param {string} userId - Current user ID
 * @param {Array} gameProps - Array of game properties from DB
 * @param {number} currentRound - Current game round number
 * @returns {boolean} True if player has at least 1 property eligible for improvement
 */
export function canImproveAnyProperties(userId, gameProps = [], currentRound = 1) {
  if (!userId || !Array.isArray(gameProps)) return false;

  const myProperties = gameProps.filter((gp) => gp.owner_user_id === userId && !gp.is_sold_to_buyer);
  if (myProperties.length === 0) return false;

  return myProperties.some((gp) => {
    // Cannot improve in the round it was purchased
    if (gp.purchased_round === currentRound) return false;

    // Cannot improve if actively listed
    if (gp.is_listed) return false;

    // Cannot improve if listed in the same round
    if (gp.last_listed_round === currentRound || gp.listed_round === currentRound) return false;

    // Cannot improve if already max upgraded (5 improvements)
    const improvements = Array.isArray(gp.improvements) ? gp.improvements : [];
    if (improvements.length >= 5) return false;

    return true;
  });
}
