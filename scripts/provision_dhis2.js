import axios from 'axios';
import { resolve } from 'path';
import 'dotenv/config'; // Assumes .env is in the process root or loaded via NODE_ENV

const baseURL = process.env.DHIS2_BASE_URL || 'https://play.dhis2.org/40.0.1';
const pat = process.env.DHIS2_PAT;

if (!pat) {
    console.error("FATAL: Environment variable DHIS2_PAT is missing.");
    process.exit(1);
}

// Axios instance configured with exactly what the DHIS2 REST API expects
const api = axios.create({
    baseURL: `${baseURL}/api`,
    headers: {
        'Authorization': `ApiToken ${pat}`,
        'Content-Type': 'application/json'
    }
});

/**
 * Utility to make script IDEMPOTENT.
 * Checks if a metadata object already exists by querying its exact name.
 * If it does, returns its DHIS2 auto-generated UID.
 */
async function getEntityId(endpoint, name) {
    try {
        // We use DHIS2's built-in field filtering to only pull down the ID string to save bandwidth
        const res = await api.get(`/${endpoint}?filter=name:eq:${name}&fields=id`);
        if (res.data[endpoint] && res.data[endpoint].length > 0) {
            return res.data[endpoint][0].id;
        }
        return null;
    } catch (e) {
        console.error(`[GET FAILED] ${endpoint} -> ${name}`);
        return null;
    }
}

/**
 * Utility to POST new metadata.
 * Returns the auto-generated UID from the DHIS2 response.
 */
async function createEntity(endpoint, payload) {
    try {
        const res = await api.post(`/${endpoint}`, payload);
        // Extract the UID created by DHIS2, buried in the response object
        return res.data.response.uid;
    } catch (e) {
        console.error(`[POST FAILED] ${endpoint}:`, e.response?.data?.message || e.message);
        throw e;
    }
}

// Main Runner
async function provision() {
    console.log("=== Starting Idempotent DHIS2 Provisioning ===");

    // 1. ORGANISATION UNITS
    // Hierarchy: Nigeria > Kano State > LGA > Facility
    const orgUnitHierarchy = ['Nigeria', 'Kano State', 'LGA', 'Facility'];
    let parentId = null;
    let facilityId = null; // We save the final facility ID to link to the program later

    for (const ouName of orgUnitHierarchy) {
        let ouId = await getEntityId('organisationUnits', ouName);
        if (!ouId) {
            console.log(`Creating OrgUnit: ${ouName}`);
            const payload = {
                name: ouName,
                shortName: ouName.substring(0, 50),
                openingDate: "2024-01-01",
                parent: parentId ? { id: parentId } : undefined
            };
            ouId = await createEntity('organisationUnits', payload);
        } else {
            console.log(`Exists OrgUnit: ${ouName} (${ouId})`);
        }
        parentId = ouId;
        if (ouName === 'Facility') facilityId = ouId;
    }

    // 2. TRACKED ENTITY TYPE
    const tetName = "Pregnant Woman";
    let tetId = await getEntityId('trackedEntityTypes', tetName);
    if (!tetId) {
        console.log(`Creating TrackedEntityType: ${tetName}`);
        tetId = await createEntity('trackedEntityTypes', {
            name: tetName,
            shortName: "PregWoman"
        });
    } else {
        console.log(`Exists TrackedEntityType: ${tetName} (${tetId})`);
    }

    // 3. PROGRAM
    const progName = "MamaAlert ANC";
    let progId = await getEntityId('programs', progName);
    if (!progId) {
        console.log(`Creating Program: ${progName}`);
        progId = await createEntity('programs', {
            name: progName,
            shortName: "MamaAlertANC",
            programType: "WITH_REGISTRATION",
            trackedEntityType: { id: tetId },
            organisationUnits: [{ id: facilityId }] // Assign the program to our lowest level facility
        });
    } else {
        console.log(`Exists Program: ${progName} (${progId})`);
    }

    // 4. PROGRAM STAGES
    const stages = ["Antenatal Visit", "Labour Triage", "Neonatal Assessment"];
    for (const stageName of stages) {
        let stageId = await getEntityId('programStages', stageName);
        if (!stageId) {
            console.log(`Creating ProgramStage: ${stageName}`);
            await createEntity('programStages', {
                name: stageName,
                program: { id: progId },
                sortOrder: stages.indexOf(stageName) + 1 // Ensure they ordered correctly in the UI
            });
        } else {
            console.log(`Exists ProgramStage: ${stageName} (${stageId})`);
        }
    }

    console.log("=== Provisioning Complete ===");
}

provision().catch(console.error);
