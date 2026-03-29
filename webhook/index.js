import express from 'express';
import { XMLParser } from 'fast-xml-parser';
import axios from 'axios';
import 'dotenv/config'; // Loads environment variables seamlessly (e.g., from ../local_setup/.env)

const app = express();
const port = process.env.PORT || 3000;

// Setup DHIS2 REST integration for our Phase 4 Bridge
const dhis2 = axios.create({
    baseURL: `${process.env.DHIS2_BASE_URL}/api`,
    headers: {
        'Authorization': `ApiToken ${process.env.DHIS2_PAT}`,
        'Content-Type': 'application/json'
    }
});

app.get('/', (req, res) => {
    res.send('Raya Webhook Server is running. Use POST /ussd for Africa\'s Talking.');
});

app.get('/ussd', (req, res) => {
    res.send('AT USSD endpoint active. Awaiting POST requests from Africa\'s Talking.');
});

// Africa's Talking (AT) POSTs their USSD payloads using standard form URL encoding.
// Express requires this middleware to automatically parse req.body into a JavaScript object.
app.use(express.urlencoded({ extended: true }));

// CommCare POSTs its data forwarding payloads as raw XML text.
// This middleware parses any incoming request with an XML content type into a raw text string on req.body.
app.use(express.text({ type: ['application/xml', 'text/xml'] }));

// Array simulating our "webhook database" for logging USSD sessions to satisfy acceptance test T6.
const sessionLogDb = [];

// ==========================================
// PHASE 2: AFRICA'S TALKING USSD FALLBACK
// Satisfaction of Tests: T6 & T7
// ==========================================
app.post('/ussd', (req, res) => {
    // AT sends the user's sequential inputs separated by the '*' character in the 'text' property.
    // For example, if they chose option 1 then 2, text = "1*2"
    const { sessionId, serviceCode, phoneNumber, text } = req.body;

    // We split the inputs into an array to understand exactly what stage of the menu the user is at.
    // If text is empty (user just dialed), the array should be empty.
    const textArray = text ? text.split('*') : [];
    
    // The length of the array tells us our current "Step" in the dialogue tree.
    const step = textArray.length;

    let response = '';

    // Step 0: The user just dialed the shortcode (text is empty)
    if (step === 0) {
        // 'CON' tells the AT platform that the session is ongoing and expects user input next.
        response = `CON Enter patient ID or NEW`;
    } 
    // Step 1: User has entered the patient ID, we now ask for danger signs (Triage layer)
    else if (step === 1) {
        // The first text input (e.g., patient ID "123") sits at textArray[0]. We proceed to the next menu.
        response = `CON Any danger signs?\n1. Bleeding\n2. Fits\n3. No breathing\n4. None`;
    }
    // Step 2: User has selected a danger sign. We evaluate the triage condition.
    else if (step === 2) {
        // We pull the exact choice the user inputted for the danger sign prompt inside textArray[1]
        const dangerSignChoice = textArray[1];
        
        // Triage Logic: If they selected 1 (Bleeding), 2 (Fits), or 3 (No breathing)
        if (['1', '2', '3'].includes(dangerSignChoice)) {
            // Map the numerical choice to the plain English danger sign for the response message
            const dangerSignMap = { '1': 'Bleeding', '2': 'Fits', '3': 'No breathing' };
            const specificSign = dangerSignMap[dangerSignChoice];
            
            // 'END' tells the AT platform to display the message and immediately terminate the radio session.
            response = `END REFER NOW. Danger sign: ${specificSign}.\nCall referral line: 08001234567`;
            
            // Log the session as requested in T6: "AND the session is logged in our webhook database"
            sessionLogDb.push({ sessionId, phoneNumber, outcome: 'REFERRED', sign: specificSign });
            console.log(`[USSD LOG] Session ${sessionId} -> REFERRED for ${specificSign}`);
        } 
        // If they selected 4 (None), they pass the triage safely (satisfying T7)
        else if (dangerSignChoice === '4') {
            response = `END No danger signs. Monitor patient.\nReturn visit in 48 hours.`;
            
            sessionLogDb.push({ sessionId, phoneNumber, outcome: 'SAFE' });
            console.log(`[USSD LOG] Session ${sessionId} -> SAFE`);
        } 
        // Fallback for invalid inputs
        else {
            response = `END Invalid entry. Please dial again.`;
        }
    } 
    // Catch-all for anything beyond step 2 just to be safe
    else {
        response = `END Session max length reached.`;
    }

    // Africa's Talking strictly expects a text/plain response within 5 seconds
    res.set('Content-Type', 'text/plain');
    res.send(response);
});

// ==========================================
// PHASE 4: COMMCARE XML DATA FORWARDING BRIDGE
// Satisfaction of Tests: T9 (Endpoint & XML Parsing Verification)
// ==========================================
app.post('/commcare/webhook', (req, res) => {
    try {
        // Instantiate the XML Parser from the 'fast-xml-parser' package.
        // ignoreAttributes: false ensures we extract properties written as XML attributes (like XMLNS).
        // attributeNamePrefix: "@_" helps us easily identify attributes vs tags in the resulting JS object.
        const parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: "@_"
        });
        
        // Convert the raw CommCare XML string into a navigable JavaScript object.
        const xmlData = parser.parse(req.body);
        
        // Navigate down to the root `<data>` block containing all offline Javarosa inputs.
        const formData = xmlData.data;
        if (!formData) {
            return res.status(400).send('Invalid XML Payload: Missing <data> root');
        }

        // We pull the XMLNS fingerprint directly from the payload to route the logic correctly (Gotcha #7).
        const xmlns = formData['@_xmlns'];
        
        if (xmlns === 'http://openrosa.org/formdesigner/ANC-RISK-SCORING-V1') {
            const isHighRisk = formData.is_high_risk;
            console.log(`[BRIDGE] Parsed ANC Form successfully. Extracted high_risk flag: ${isHighRisk}`);
            
            // MAP COMMCARE XML -> DHIS2 TRACKER PAYLOAD
            // Because CommCare handles offline collection, once it hits this bridge, 
            // we actively push the data into DHIS2 via the Unified Tracker payload /api/tracker (v2.36+)
            
            // CAUTION: In production, the IDs here should be dynamic fetched from DHIS2 configs (using provision_dhis2.js IDs).
            // This is the semantic skeleton of what MOTECH achieves.
            const dhis2TrackerEvent = {
                events: [
                    {
                        // The tracked entity id representing Hauwa
                        trackedEntity: formData.case?.['@_case_id'] || "offline_sync_id", 
                        program: "MamaAlertANC_ID_From_Script",
                        programStage: "AntenatalVisit_ID",
                        orgUnit: "Facility_ID",
                        occurredAt: new Date().toISOString(),
                        status: "COMPLETED",
                        dataValues: [
                            // Translate the XML strings into DHIS2 data element metadata values
                            { dataElement: "BP_Sys_Element_ID", value: formData.bp_systolic },
                            { dataElement: "BP_Dia_Element_ID", value: formData.bp_diastolic },
                            { dataElement: "Oedema_Element_ID", value: formData.oedema }
                        ]
                    }
                ]
            };

            // Async REST call using Axios to DHIS2 Tracker API
            dhis2.post('/tracker', dhis2TrackerEvent)
                 .then(res => console.log(`[DHIS2] Successfully ingested Tracker Event!`))
                 .catch(err => console.error(`[DHIS2 ERROR] Failed to ingest record:`, err.response?.data?.message || err.message));
        }

        // Always return HTTP 200 quickly so CommCare knows the sync succeeded and doesn't queue a retry
        res.status(200).send('Webhook Processed');
    } catch (e) {
        console.error('Error parsing CommCare XML webhook:', e);
        res.status(500).send('Internal Server Error');
    }
});

app.listen(port, () => {
    console.log(`Raya Webhook Server active on port ${port}`);
});
