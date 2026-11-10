<p align="center">
  <img src="frontend/public/houseflippah-logo.svg" alt="houseflippah logo" width="420" />
</p>

# Game Rules

Welcome to **houseflippah**, a turn-based real estate investing and flipping game for 1 to 4 players. Compete against other players to build wealth by financing real estate, making strategic renovations, managing mortgage payments, and flipping properties to automated buyers for maximum profit.



## 1. Setup & Starting Conditions

* **Players**: 1 to 4 players per room.
* **Starting Bankroll**: Each player begins the game with **$100,000 in cash**.
* **Turn Order**: Gameplay proceeds sequentially by seat number (Seat 1, Seat 2, etc.).
* **Rounds**: A round concludes once every active player has completed their turn. The game then advances to the next round.



## 2. Buying Properties

* **Bank-Owned Properties**: 28 properties are initially available in the public catalog.
* **Financing (10% Down)**: Properties are purchased with a **10% cash down payment**. Then 40 payments of 1/40th the purchase price (effectively a simple 10% interest rate).
* **Purchase Limit**: You can only purchase **1 property per round**.
* **Round 1 Mortgage Waiver**: The mortgage payment for the round in which a property is purchased is automatically covered.



## 3. Renovations & Improvements

Properties can be improved to increase their overall market value:
* **Eligible Upgrades**: Each property supports up to 5 distinct renovation tiers:
  1. *Windows & Doors*
  2. *HVAC & Mechanicals*
  3. *Roof & Siding*
  4. *Flooring & Painting*
  5. *Kitchen & Bathrooms*
* **Costs & Value Boost**:
  * Each improvement costs **10% of the property's original purchase price**.
  * Each installed improvement boosts the property's market value by **20% of its original purchase price**.
  * Fully renovated properties double their base value (+100% market value).
  * Each specific improvement can only be installed once per property.
* **Timing & Holding Restrictions**:
  * **No Same-Round Improvement**: You cannot make improvements to a property in the same round it was purchased (must hold for at least 1 round).
  * **No Listed Improvements**: You cannot improve a property that is currently listed for sale, nor can you improve a property in the same round it was delisted.



## 4. Mortgages, Delinquency & Foreclosure

* **Mortgage Payments**: Starting the round following purchase, each owned property requires a mortgage payment equal to **1/40th of its original purchase price**.
* **Delinquency**:
  * If a player fails to make the mortgage payment during a round, the property becomes **delinquent** (1 missed payment).
  * Delinquent properties can be brought current by making a double payment (or kept afloat by making a single payment).
* **Foreclosure**:
  * If a delinquent property misses a second consecutive mortgage payment, the bank **forecloses** on the property.
  * The defaulting owner loses the deed and all equity.
  * The foreclosed property returns to the bank-owned pool with its outstanding mortgage wiped clean.
  * **Improvements Preserved**: Any improvements already installed remain on the foreclosed property, maintaining its higher market value for anyone who purchases it from the bank.



## 5. Listing & Selling Properties

* **Improvement Required**: You **cannot list an unimproved property**. At least one improvement must be completed before listing.
* **No Same-Round Listing**: You cannot list a property in the same round it was purchased.
* **No Same-Round Improve & List**: You cannot list a property in the same round improvements were made to it.
* **Minimum Asking Price**: Your list price must be at least equal to the property's remaining mortgage balance.
* **Delisting**: An active listing can be delisted at any time during your turn.



## 6. The Automated Buyer Pool & Market Temperature

At the conclusion of each round, an automated pool of outside buyers evaluates all actively listed properties:

* **Market Temperatures**: Each round features a market temperature that sets the base odds of a property selling:
  * 🧊 **Ice Cold**: 10% base sale odds
  * 🧣 **Chilly**: 20% base sale odds
  * ⛅ **Comfy**: 30% base sale odds
  * ☀️ **Toasty**: 40% base sale odds
  * 🔥 **On Fire**: 50% base sale odds

* **Improvement Odds Boost**:
  * Each installed improvement increases the property's base selling odds by **+5%**.
  * For example, in an "On Fire" market (50% base odds), a property with 1 improvement has a 55% chance of selling at market value, while a property with all 5 improvements has a 75% chance of selling at market value.
  * Unimproved properties cannot be listed and have a 0% chance of selling.

* **Pricing vs. Market Value**:
  * Listing **at market value** sells at the effective base odds (market temperature base odds + improvement bonus).
  * Listing **below market value** **increases** the odds of selling proportional to the discount.
  * Listing **above market value** **decreases** the odds of selling proportional to the markup.

* **Sales Settlement**:
  * When a property sells, the automated buyer pays the full asking price.
  * The outstanding mortgage balance is automatically paid off first.
  * Net profits are credited directly to the player's cash on hand.
  * Sold properties are archived to the transaction ledger and permanently retired from circulation.



## 7. Round-Start Events & Alerts

At the start of every new round, all players receive simultaneous pop-up alerts before any turn begins:
* **Market Sales Report**: Detailed confirmation of all property sales completed by automated buyers at round close (seller, buyer name, sale price, mortgage payoff, and net proceeds).
* **Delinquency Warnings**: Alerts players who missed a mortgage payment during the previous round and are at risk of foreclosure.
* **Foreclosure Notices**: Alerts any player whose property was seized and returned to the bank due to consecutive missed mortgage payments.



## 8. Player Resignation & Viewer Mode

Any player can choose to resign from an active game at any time:
* **Resignation Confirmation**: Players are prompted with a confirmation dialog before forfeiting.
* **Property Forfeiture**: All properties owned by the resigning player immediately return to the bank-owned pool (mortgages wiped clean, improvements preserved).
* **Viewer Mode**: Resigned players remain in the match as spectators. The "Resign Game" button is disabled, the HUD turn badge displays **Resigned**, and the player can observe ongoing market activity and reports.
* **Turn Skipping**: Resigned players are permanently skipped during all subsequent turn rotations.
* **Host Resignation**: If the room host resigns, they retain their host privileges and the "End Game" button in viewer mode.
* **Sole Survivor Victory**: In multiplayer games, when all opponents have resigned and exactly 1 active player remains, the match automatically concludes with a victory for the sole survivor.



## 9. Winning the Game & Total Equity

* **Total Equity Calculation**: A player's financial standing and net worth are measured in **Total Equity**:
  $$\text{Total Equity} = \text{Cash on Hand} + \sum (\text{Market Value of Owned Properties}) - \sum (\text{Mortgage Balances})$$
* **Leaderboards & Victory**: Players can review real-time equity rankings in the Financial Report. When the match concludes—either through a sole survivor victory or when the host ends the game—the final victory screen highlights the winner's total equity, remaining cash, and real estate portfolio.
