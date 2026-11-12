/**
 * Determine if a player owns any properties that can be listed for sale (or are already listed).
 * Properties must have at least 1 improvement in order to be listed.
 *
 * @param {string} userId - Current user ID
 * @param {Array} gameProps - Array of game properties from DB
 * @returns {boolean} True if player has at least 1 property that is either actively listed or has at least 1 improvement
 */
export function canListAnyProperties(userId, gameProps = []) {
  if (!userId || !Array.isArray(gameProps)) return false;

  const myProperties = gameProps.filter((gp) => gp.owner_user_id === userId);
  if (myProperties.length === 0) return false;

  return myProperties.some((gp) => {
    if (gp.is_listed) return true;
    const improvements = Array.isArray(gp.improvements) ? gp.improvements : [];
    return improvements.length > 0;
  });
}
