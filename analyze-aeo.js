const http = require("http")
const https = require("https")
const { URL } = require("url")

const CRITERIA = [
    ["answer", "Answer clarity", 20, "Clear, extractable answers near the top of the page."],
    ["questions", "Question coverage", 16, "Headings and copy cover natural search questions."],
    ["schema", "Structured data", 16, "Schema.org JSON-LD identifies entities and page type."],
    ["trust", "Trust signals", 16, "Author, dates, sources, organization, and proof are visible."],
    ["crawl", "Crawlability", 14, "Indexing and snippets are allowed."],
    ["depth", "Content depth", 10, "The page has enough original supporting detail."],
    ["technical", "Technical basics", 8, "Metadata, headings, canonicals, and image alt text are clean."],
]

function fetchUrl(rawUrl) {
    return new Promise((resolve, reject) => {
        let parsed
        try { parsed = new URL(rawUrl) } catch { reject(new Error("Please enter a valid URL.")); return }
        if (!["http:", "https:"].includes(parsed.protocol)) { reject(new Error("Only HTTP and HTTPS URLs are supported.")); return }
        const client = parsed.protocol === "https:" ? https : http
        const request = client.get(parsed, { timeout: 15000, headers: { "User-Agent": "AEOChecker/1.0", Accept: "text/html,application/xhtml+xml,*/*" } }, response => {
            const status = response.statusCode || 0
            if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
                response.resume(); fetchUrl(new URL(response.headers.location, parsed).toString()).then(resolve, reject); return
            }
            if (status < 200 || status >= 400) { response.resume(); reject(new Error("The page returned HTTP " + status + ".")); return }
            let html = ""
            response.setEncoding("utf8")
            response.on("data", chunk => { html += chunk; if (html.length > 2000000) request.destroy(new Error("The page is larger than the 2 MB audit limit.")) })
            response.on("end", () => resolve({ html: html, finalUrl: parsed.toString() }))
        })
        request.on("timeout", () => request.destroy(new Error("The request timed out.")))
        request.on("error", reject)
    })
}
function textOnly(html) { return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'").replace(/\s+/g, " ").trim() }
function all(html, regex) { return Array.from(html.matchAll(regex)).map(match => match[1] || match[0]) }
function blocks(html, tag) { return all(html, new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "gi")).map(textOnly).filter(Boolean) }
function cap(value, max) { return Math.max(0, Math.min(max, value)) }
function count(text, regex) { return (text.match(regex) || []).length }
function analyze(html, url) {
    const text = textOnly(html), lowerText = text.toLowerCase(), lowerHtml = html.toLowerCase()
    const words = text.match(/\b[\w'-]+\b/g) || []
    const paragraphs = blocks(html, "p"), headings = ["h1", "h2", "h3"].flatMap(tag => blocks(html, tag)), listItems = blocks(html, "li"), h1s = blocks(html, "h1")
    const title = (all(html, /<title[^>]*>([\s\S]*?)<\/title>/i)[0] || "").trim()
    const description = (all(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i)[0] || "").trim()
    const jsonLd = all(html, /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
    const schemaTypes = []
    for (const block of jsonLd) { try { const parsed = JSON.parse(block.trim()); const nodes = Array.isArray(parsed) ? parsed : [parsed]; for (const node of nodes) { if (!node || typeof node !== "object") continue; if (node["@type"]) schemaTypes.push(String(node["@type"])); if (Array.isArray(node["@graph"])) for (const graphNode of node["@graph"]) if (graphNode && graphNode["@type"]) schemaTypes.push(String(graphNode["@type"])) } } catch { schemaTypes.push("Invalid JSON-LD") } }
    const questionHeadings = headings.filter(heading => /\?|\b(who|what|when|where|why|how|can|does|do|is|are|should|best|cost|price|vs)\b/i.test(heading))
    const noindex = /noindex/i.test(lowerHtml), nosnippet = /nosnippet|max-snippet:0/i.test(lowerHtml)
    const trustHits = [/\bauthor\b/i, /\breviewed by\b/i, /\bupdated\b/i, /\bcontact\b/i, /\babout\b/i, /\bcase study\b/i, /\bsources?\b/i, /\bexpert\b/i].filter(regex => regex.test(text)).length
    const imageCount = all(html, /<img\b[^>]*>/gi).length, imagesWithAlt = all(html, /<img[^>]+alt=["'][^"']+["'][^>]*>/gi).length
    const scores = {
        answer: cap((paragraphs.some(p => p.length >= 80 && p.length <= 360) ? 7 : 0) + Math.min(5, count(text, /\b(in short|the answer is|yes,|no,|to fix|steps?|because|for example)\b/gi)) + (listItems.length >= 4 ? 4 : 0) + (headings.length >= 3 ? 4 : 0), 20),
        questions: cap(Math.min(8, questionHeadings.length * 2) + (/faq|frequently asked questions/i.test(text) ? 4 : 0) + (/howto|step-by-step|step by step/i.test(text) ? 2 : 0) + (count(text, /\?/g) >= 3 ? 2 : 0), 16),
        schema: cap((jsonLd.length ? 6 : 0) + Math.min(6, schemaTypes.filter(type => !/invalid/i.test(type)).length * 2) + (schemaTypes.some(type => /article|product|organization|localbusiness|person|service|faq|howto/i.test(type)) ? 4 : 0), 16),
        trust: cap(Math.min(10, trustHits * 2) + (/\b(20\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(text) ? 2 : 0) + (/\b\d+(\.\d+)?%|\b\d+\+|\b\d{2,}\b/.test(text) ? 2 : 0) + (lowerText.includes("by ") || lowerText.includes("team") ? 2 : 0), 16),
        crawl: cap((noindex ? 0 : 6) + (nosnippet ? 0 : 4) + (text.length > 800 ? 2 : 0) + (/<meta[^>]+name=["']robots["']/i.test(html) && !noindex && !nosnippet ? 2 : 0), 14),
        depth: cap((words.length >= 600 ? 5 : words.length >= 300 ? 3 : words.length >= 150 ? 1 : 0) + (paragraphs.length >= 6 ? 2 : 0) + (listItems.length >= 5 ? 1 : 0) + (count(text, /\b(example|data|study|research|compare|benefit|risk|limitation)\b/gi) >= 4 ? 2 : 0), 10),
        technical: cap((title.length >= 20 && title.length <= 70 ? 2 : 0) + (description.length >= 70 && description.length <= 170 ? 2 : 0) + (h1s.length === 1 ? 2 : 0) + (/<link[^>]+rel=["']canonical["']/i.test(html) ? 1 : 0) + (imageCount === 0 || imagesWithAlt / imageCount >= 0.6 ? 1 : 0), 8),
    }
    const checks = CRITERIA.map(([id, name, weight, description]) => ({ id, name, weight, description, score: scores[id], percent: Math.round((scores[id] / weight) * 100), status: scores[id] / weight >= 0.75 ? "Good" : scores[id] / weight >= 0.5 ? "Needs work" : "Weak" }))
    const issues = [
        { impact: noindex || nosnippet ? 100 : 10, area: "Crawlability", title: "Indexing or snippet settings may block AI visibility.", evidence: noindex ? "A noindex directive appears in the HTML." : nosnippet ? "A nosnippet or max-snippet:0 directive appears in the HTML." : "No obvious noindex or snippet block was detected.", fix: "Allow indexing and useful snippets on pages you want considered for search and AI answer surfaces." },
        { impact: scores.answer < 13 ? 95 : 30, area: "Answer clarity", title: "The page does not give AI systems a clean answer to lift.", evidence: paragraphs.some(p => p.length >= 80 && p.length <= 360) ? "Some concise paragraphs exist, but answer cues are thin." : "No strong 80-360 character answer block was found.", fix: "Add a direct answer paragraph immediately after the main heading, then support it with bullets, examples, and follow-up details." },
        { impact: scores.questions < 10 ? 90 : 35, area: "Question coverage", title: "The content is not mapped to conversational questions.", evidence: questionHeadings.length + " question-style heading" + (questionHeadings.length === 1 ? "" : "s") + " found.", fix: "Add FAQ-style H2/H3 sections for who, what, how, cost, comparison, and edge-case questions your buyers actually ask." },
        { impact: scores.schema < 10 ? 85 : 25, area: "Structured data", title: "Structured data is weak or missing.", evidence: jsonLd.length ? "Found " + jsonLd.length + " JSON-LD block(s): " + (schemaTypes.join(", ") || "no clear @type values") + "." : "No JSON-LD structured data was found.", fix: "Add valid JSON-LD for the page type: Organization, Article, Product, Service, LocalBusiness, FAQPage, or HowTo where accurate." },
        { impact: scores.trust < 10 ? 80 : 25, area: "Trust", title: "Trust and source signals are not obvious enough.", evidence: trustHits + " trust cue" + (trustHits === 1 ? "" : "s") + " detected.", fix: "Show author/reviewer names, update dates, credentials, source links, company details, and real proof such as examples or data." },
        { impact: scores.depth < 6 ? 70 : 20, area: "Content depth", title: "The page may be too thin to deserve citation.", evidence: words.length + " visible words detected.", fix: "Add original detail: definitions, process steps, comparisons, limitations, examples, data, and concise summaries." },
    ].sort((a, b) => b.impact - a.impact).slice(0, 3)
    const overall = Math.round(checks.reduce((sum, check) => sum + check.score, 0))
    return { url, overall, grade: overall >= 85 ? "Excellent" : overall >= 70 ? "Strong" : overall >= 50 ? "Needs work" : "At risk", summary: overall >= 70 ? "This page has a solid AEO foundation, but there are still opportunities to make answers easier to extract and trust." : "This page needs clearer answer structure, stronger trust signals, or better machine-readable context before it is likely to perform well in answer engines.", checks, issues, facts: { title, description, wordCount: words.length, headingCount: headings.length, questionHeadingCount: questionHeadings.length, jsonLdCount: jsonLd.length, schemaTypes: [...new Set(schemaTypes)], imageCount, imagesWithAlt } }
}
module.exports = async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*"); res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS"); res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (req.method === "OPTIONS") { res.status(204).end(); return }
    if (req.method !== "GET") { res.status(405).json({ error: "Use GET with ?url=https://example.com" }); return }
    try { const target = req.query.url; if (!target) throw new Error("Add a URL to analyze."); const { html, finalUrl } = await fetchUrl(target); res.status(200).json(analyze(html, finalUrl)) } catch (error) { res.status(400).json({ error: error.message || "The audit failed." }) }
}
