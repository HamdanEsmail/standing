# Curated watches

Chosen on 9 Nov 2026 from public notices; I approved each one before any watch was made (spec section 7). People are listed by registration number only; companies by name and number.

| Register | Who | Why it may change before 17 Nov | Status on 9 Nov | Watch |
|---|---|---|---|---|
| Companies House | ROUND TABLE ENTERPRISES LIMITED, 10973794 | Winding-up order published in The Gazette on 8 Nov 2026 | active, flag `proposal_to_strike_off` ("Active — Active proposal to strike off") | Page monitor on the company page |
| Companies House | MARLBOROUGH ONE LTD, 15445659 | Winding-up order published in The Gazette on 8 Nov 2026 | active, flag `proposal_to_strike_off` | Page monitor on the company page |
| Companies House | HEALTH & SOCIAL CONNECT MULTI-MEDIA LIMITED, 10425232 | Winding-up order published in The Gazette on 8 Nov 2026 | active, flag `proposal_to_strike_off` | Page monitor on the company page |
| NMC | PIN 22H1252O | Fitness-to-practise hearing listed for 11 Nov 2026 on the NMC's public hearings page | suspended, flag `interim_order` ("Not on the register - Interim suspension order") | Topic monitor on the name, plus the shared NMC hearings page |

NMC PIN 85A1154E (hearing listed for 13 Nov 2026) was approved first but not watched: on 9 Nov the NMC search page showed a CAPTCHA to the check, and Standing does not get past robot checks. The fourth slot went to the third company on the list instead, which I had approved too.

How an outcome shows up: a company's Page monitor re-reads the company page twice a day, and a change of status (for example to Liquidation) is a `status_change` event with before and after. For the NMC registrant, either the Topic monitor finds a new public notice about the hearing or the shared hearings page adds a line with the PIN; each is a `notice` event and triggers one re-check, whose result is a `status_change` if the register's status moved, else a `recheck`.
