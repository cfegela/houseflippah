/**
 * Determine if a player has any properties eligible to access the mortgage payments page.
 * Triggers warning modal if player owns zero properties.
 *
 * @param {string} userId - Current user ID
 * @param {Array} gameProps - Array of game properties from DB
 * @returns {boolean} True if player owns at least 1 property
 */
export function hasPayableMortgages(userId, gameProps = []) {
  if (!userId || !Array.isArray(gameProps)) return false;

  const myProperties = gameProps.filter((gp) => gp.owner_user_id === userId && !gp.is_sold_to_buyer);
  return myProperties.length > 0;
}
