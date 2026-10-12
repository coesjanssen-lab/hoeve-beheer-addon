# Hoeve Beheer

De beheer-app van Hoeve Wetermans, draaiend in Home Assistant. Alle gegevens (taken,
bezetting, logboek, contacten, projecten, foto's, documenten en Tommy-exports) staan op
deze Pi in plaats van in Google Drive.

## Openen
Zijbalk → **Hoeve Beheer**. Werkt ook onderweg via de Home Assistant-app.
Iedere Home Assistant-gebruiker (ook zonder beheerdersrechten) kan de app openen.

## Instellingen
- **Anthropic API-sleutel**: nodig voor AI-tags op foto's. Blijft op de Pi.

## Schoonmaakrooster
Na een Tommy-import of "Maak schoonmaakrooster" gaat het rooster direct naar Home
Assistant (event `hoeve_beheer_rooster`). Er is geen webhook-adres nodig.

## Back-up
- Automatisch: de gegevens zitten in elke Home Assistant-back-up.
- Handmatig: in de app → Instellingen → **Download back-up** / **Back-up terugzetten**.
  Bij terugzetten blijven de vorige gegevens op de Pi bewaard als `drive.vorige`.
