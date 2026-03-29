# Raya: Maternal Health Offline-First Decision Support

Raya is a robust, offline-first clinical decision support system designed for Community Health Extension Workers (CHEWs) in Nigeria. Its core objective is to reduce maternal and neonatal mortality in remote areas by detecting high-risk pregnancies (like pre-eclampsia) early, routing dynamic data via DHIS2 Tracker, and supporting an SMS/USSD fallback logic layer for immediate triage when mobile internet is scarce.

This project integrates four critical infrastructure layers:
1. **CommCare XForms** - For complex, strictly offline data collection on Android.
2. **Africa's Talking USSD Fallback** - A zero-data triage fallback for feature phones.
3. **DHIS2 Provisioning** - Idempotent REST API scripts to map healthcare hierarchies and tracker metadata.
4. **MOTECH Data Bridge** - A Node.js middleware server that listens to CommCare Webhooks and syncs JSON data securely into the unified DHIS2 Tracker via `axios`.

## Architecture & Code Map

* `commcare/anc_form.xml`: The standalone offline XForm. Contains native OpenRosa (Javarosa) calculations and binding constraints to evaluate gestational age and blood pressure locally.
* `webhook/index.js`: The Express.js backend Server executing Phase 2 and Phase 4. Handles dynamic USSD prompts on `POST /ussd` and processes CommCare XML syncs on `POST /commcare/webhook` using `fast-xml-parser`.
* `scripts/provision_dhis2.js`: A secure, idempotent Node.js script designed to map Tracker metadata directly to DHIS2 v2.40+.
* `local_setup/.env.example`: Reference configuration for managing PAT (Personal Access Tokens), API keys, and Sandbox credentials.

## Setup & Testing Guide

Before diving in, copy the example environment template:
```bash
cp local_setup/.env.example local_setup/.env
```
Ensure your DHIS2 credentials (e.g., from `play.dhis2.org`) and Africa's Talking Sandbox API keys are configured inside your new `.env` file.

### 1. Provisioning DHIS2 Metadata (Phase 3)
To initialize the backend tracker infrastructure:
```bash
# Run the idempotent setup
node scripts/provision_dhis2.js
```
*Note: Due to its idempotent design, you can run this multiple times without duplicating OrgUnits or Programs!*

### 2. Spinning up the Webhook & MOTECH Bridge (Phase 2 & 4)
We use Ngrok to tunnel our local server so CommCare and Africa's Talking can reach it securely.
```bash
cd webhook
npm install
node index.js
```
In a new terminal tab, launch Ngrok for port 3000:
```bash
ngrok http 3000
```
* Take your dynamically generated Ngrok URL (e.g., `https://xxxx.ngrok-free.app`) and paste it into the **Africa's Talking Sandbox Dashboard** under your USSD callback appending `/ussd`.
* Paste the exact same URL appended with `/commcare/webhook` into your **CommCare HQ Data Forwarding** webhook settings.

### 3. Acceptance Testing
1. **USSD Danger Sign Triage:** Open the Africa's Talking Sandbox Simulator. Dial your registered shortcode (e.g., `*384*56224#`). Hit option `1` for severe signs (Bleeding) to see the immediate session logic terminate and instruct an emergency referral seamlessly.
2. **Offline XForms Sync:** Import `anc_form.xml` into CommCare HQ App Builder Settings -> Advanced -> Import XForm. Open the Android application fully offline, trigger a "High Risk" blood pressure condition, and witness the dynamic Referral Slip UI pop up.
3. Once the Android device hits a 2G/WiFi connection, CommCare's sync fires the XML data straight into our `POST /commcare/webhook`. Notice the terminal logs parse the XML, extract the `is_high_risk` flag, and trigger the Axios Tracker POST securely to DHIS2.

## Technologies Used
- **Node.js 20+ (ES Modules)**
- **Express / fast-xml-parser / Axios**
- **DHIS2 REST API v2.36+ (Tracker)**
- **CommCare Javarosa XForms**
- **Africa's Talking API**
