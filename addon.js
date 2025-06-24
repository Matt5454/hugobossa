const sdk = require("stremio-addon-sdk");
const axios = require('axios');
const crypto = require('crypto');

// =================================================================
const WSHARE_USER = 'jitka.matouskova';
const WSHARE_PASSWORD = 'elousek2004';
// =================================================================

function md5Crypt(password, salt) { /* ... celý kód pro šifrování zůstává stejný ... */ let magic = '$1$'; if (salt.indexOf(magic) === 0) { salt = salt.substring(magic.length, salt.indexOf('$', magic.length)); } else { salt = salt.substring(0, 8); } let final = magic + salt + '$'; let ctx = crypto.createHash('md5'); ctx.update(password + magic + salt); let altCtx = crypto.createHash('md5'); altCtx.update(password + salt + password); let altResult = altCtx.digest(); for (let i = 0; i < password.length; i++) { ctx.update(altResult.subarray(i % 16, i % 16 + 1)); } for (let i = password.length; i !== 0; i >>= 1) { if ((i & 1) !== 0) { ctx.update(Buffer.from([0])); } else { ctx.update(password.charAt(0)); } } let result = ctx.digest(); for (let i = 0; i < 1000; i++) { ctx = crypto.createHash('md5'); if ((i & 1) !== 0) { ctx.update(password); } else { ctx.update(result); } if ((i % 3) !== 0) { ctx.update(salt); } if ((i % 7) !== 0) { ctx.update(password); } if ((i & 1) !== 0) { ctx.update(result); } else { ctx.update(password); } result = ctx.digest(); } const to64 = (n, c) => { const chars = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'; let s = ''; for (let i = 0; i < c; i++) { s += chars[n & 0x3f]; n >>>= 6; } return s; }; let l = (result[0] << 16) | (result[6] << 8) | result[12]; final += to64(l, 4); l = (result[1] << 16) | (result[7] << 8) | result[13]; final += to64(l, 4); l = (result[2] << 16) | (result[8] << 8) | result[14]; final += to64(l, 4); l = (result[3] << 16) | (result[9] << 8) | result[15]; final += to64(l, 4); l = (result[4] << 16) | (result[10] << 8) | result[5]; final += to64(l, 4); l = result[11]; final += to64(l, 2); return final; }

let wstToken = null;

async function loginToWebshare() { if (wstToken) return true; try { console.log("Zahajuji přihlašování..."); const saltResponse = await axios.post('https://webshare.cz/api/salt/', new URLSearchParams({ 'username_or_email': WSHARE_USER })); const saltMatch = saltResponse.data.match(/<salt>(.*?)<\/salt>/); if (!saltMatch || !saltMatch[1]) throw new Error('Nepodařilo se získat sůl.'); const dynamicSalt = saltMatch[1]; const md5cryptedPassword = md5Crypt(WSHARE_PASSWORD, dynamicSalt); const sha1HashedPassword = crypto.createHash('sha1').update(md5cryptedPassword).digest('hex'); const digest = crypto.createHash('md5').update(`${WSHARE_USER}:Webshare:${WSHARE_PASSWORD}`).digest('hex'); const loginResponse = await axios.post('https://webshare.cz/api/login/', new URLSearchParams({ 'username_or_email': WSHARE_USER, 'password': sha1HashedPassword, 'digest': digest, 'keep_logged_in': '1' })); const tokenMatch = loginResponse.data.match(/<token>(.*?)<\/token>/); if (tokenMatch && tokenMatch[1]) { wstToken = tokenMatch[1]; console.log("✅ PŘIHLÁŠENÍ ÚSPĚŠNÉ!"); return true; } console.error("❌ Přihlášení selhalo.", loginResponse.data); return false; } catch (error) { console.error("❌ Kritická chyba při přihlašování:", error.message); return false; } }

const manifest = { id: "cz.webshare.addon.multistream", version: "1.1.0", name: "Webshare CZ (Multi-Stream)", description: "Doplněk pro Webshare.cz s více výsledky.", types: ["movie", "series"], catalogs: [], resources: ["stream"], idPrefixes: ["tt"] };
const builder = new sdk.addonBuilder(manifest);

builder.defineStreamHandler(async (args) => {
    if (!wstToken) {
        const loggedIn = await loginToWebshare();
        if (!loggedIn) return { streams: [] };
    }
    try {
        let searchQuery;
        if (args.type === 'movie') {
            const meta = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${args.id}.json`);
            searchQuery = `${meta.data.meta.name} ${meta.data.meta.year}`;
        } else {
            const [imdbId, season, episode] = args.id.split(':');
            const meta = await axios.get(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`);
            searchQuery = `${meta.data.meta.name} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
        }

        console.log(`Hledám: "${searchQuery}"`);
        const searchResponse = await axios.post('https://webshare.cz/api/search/', new URLSearchParams({ 'what': searchQuery, 'wst': wstToken }));
        const responseText = searchResponse.data;

        // Najdeme VŠECHNY bloky <file> v odpovědi
        const fileMatches = responseText.matchAll(/<file>([\s\S]*?)<\/file>/g);
        if (!fileMatches) {
            console.log("Nenalezen žádný soubor.");
            return { streams: [] };
        }

        const streamPromises = [];
        const MAX_RESULTS = 5; // <<< ZDE MŮŽETE ZMĚNIT POČET ZOBRAZENÝCH VÝSLEDKŮ

        // Zpracujeme každý nalezený soubor (až do limitu MAX_RESULTS)
        for (const fileMatch of Array.from(fileMatches).slice(0, MAX_RESULTS)) {
            const fileBlock = fileMatch[1];
            const identMatch = fileBlock.match(/<ident>\s*(.*?)\s*<\/ident>/);
            const nameMatch = fileBlock.match(/<name>\s*<!\[CDATA\[([\s\S]*?)]]>\s*<\/name>/) || fileBlock.match(/<name>(.*?)<\/name>/);

            if (identMatch && nameMatch) {
                const fileIdent = identMatch[1];
                const fileName = nameMatch[1];

                // Přidáme "slib" (promise), že pro tento soubor získáme odkaz
                streamPromises.push(
                    axios.post('https://webshare.cz/api/file_link/', new URLSearchParams({ 'ident': fileIdent, 'wst': wstToken }))
                        .then(linkResponse => {
                            const linkMatch = linkResponse.data.match(/<link>\s*(.*?)\s*<\/link>/);
                            if (linkMatch && linkMatch[1]) {
                                // Pokud se odkaz podaří získat, vrátíme objekt pro Stremio
                                return {
                                    title: `[WS] ${fileName.substring(0, 80)}`, // Přidáme prefix pro jasnou identifikaci
                                    url: linkMatch[1]
                                };
                            }
                            return null; // Pokud se odkaz nezíská, vrátíme null
                        })
                        .catch(err => {
                            console.error(`Chyba při získávání odkazu pro ${fileName}:`, err.message);
                            return null; // V případě chyby také vrátíme null
                        })
                );
            }
        }

        console.log(`Zpracovávám ${streamPromises.length} nalezených souborů...`);
        
        // Počkáme, až se všechny "sliby" dokončí
        const resolvedStreams = await Promise.all(streamPromises);

        // Odfiltrujeme neúspěšné pokusy (ty, které vrátily null)
        const validStreams = resolvedStreams.filter(stream => stream !== null);

        console.log(`Úspěšně získano ${validStreams.length} streamů.`);

        return { streams: validStreams };

    } catch (error) {
        console.error("Nastala kritická chyba v handleru streamů:", error.message);
        if (error.response && error.response.data && error.response.data.includes('LOGIN_FATAL')) {
            wstToken = null;
        }
        return { streams: [] };
    }
});

const addonInterface = builder.getInterface();
sdk.serveHTTP(addonInterface, { port: 7000 });

console.log("=====================================================");
console.log("DOPLNĚK BĚŽÍ S PODPOROU VÍCE STREAMŮ");
console.log("http://127.0.0.1:7000/manifest.json");
console.log("=====================================================");
