/**
 * Enhanced Multilingual Profanity Detection Extension
 * Version: 2.0
 * 
 * A Chrome extension for real-time profanity detection and filtering that supports multiple languages and uses hybrid detection methods.
 */

/**
 * Configuration for API access and general behavior
 */
const API_KEY = 'YOUR_API_KEY_GOES_HERE'; // Replace with your API key, use Gemini 1.5 Flash
const DEBUG = true;
const RPM_LIMIT = 15; // Gemini 1.5 Flash free tier limit is 15 RPM
const DAILY_LIMIT = 1500; // 1,500 RPD is the limit of the free tier
const CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const MAX_CACHE_SIZE = 1000; // Maximum number of cached items
const DEBOUNCE_DELAY = 500; // 500ms debounce delay
let dailyRequestCount = 0; // Tracks the number of daily requests
let dailyResetTimestamp = Date.now(); // Timestamp of the last daily reset

/**
 * Multilingual profanity patterns
 */
const PROFANITY_LIST = {
    english: [
        'fuck', 'fucking', 'fucked', 'fucker', 'motherfuck', 'motherfucker',
        'shit', 'bullshit', 'bitch', 'cunt', 'whore',
        'asshole', 'hell', 'bastard', 'dick', 'pussy', 'twat', 
        'wanker', 'arse', 'bollocks', 'prick', 'slut',
        // Common phrases
        'go to hell', 'piece of shit', 'son of a bitch', 'son of a gun',
        'what the fuck', 'who the fuck', 'kiss my ass', 'to hell',
        'go fuck yourself',
        // Variations and leetspeak
        'f*ck', 'f**k', 'sh*t', 's**t', 'b*tch',
        // Racial slurs and discriminatory terms
        'nigger', 'nigga', 'n1gger', 'n1gga', 'negro',
        'chink', 'spic', 'kike', 'wetback', 'gook',
        'fag', 'faggot', 'dyke', 'tranny',
        'jap', 'slanteye', 'beaner', 'kraut', 'honky', 'cracker',
        // Common variations
        'n\\*\\*\\*\\*r', 'n\\*\\*\\*a', 'f\\*\\*\\*ot'
    ],
    chinese: [
        '操', '傻逼', '去你妈的', '肏', '屁眼',
        // Common variations
        '5B', 'sb', 'QNM', 'cao'
    ],
    spanish: [
        'puta', 'mierda', 'pendejo', 'carajo', 'joder',
        // Common variations
        'put@', 'mierd@', 'hdp'
    ],
    arabic: [
        'كس', 'زب', 'شرموط', 'منيوك', 'عرص',
        // Common variations
        'ك*س', 'ز*ب'
    ],
    hindi: [
        'भोसड़ी', 'चूतिया', 'हरामी', 'मादरचोद', 'बहनचोद',
        // Common variations
        'च*तिया', 'ह*मी'
    ]
};

/**
 * Creates regex patterns for each language
 */
const languagePatterns = {};
for (const [lang, words] of Object.entries(PROFANITY_LIST)) {
    languagePatterns[lang] = new RegExp(`(${words.map(word => 
        word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'))
        .join('|')})`, 'giu');
}
/**
 * State management
 */
let processedNodes = new WeakSet();
let apiCallCount = 0;
let lastMinuteTimestamp = Date.now();
let isEnabled = true;

/**
 * Enhanced caching system
 */
class ProfanityCache {
    constructor() {
        this.cache = new Map();
        this.loadFromStorage();
    }

    set(text, result) {
        // Remove oldest entries if cache is too large
        if (this.cache.size >= MAX_CACHE_SIZE) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }

        this.cache.set(text, {
            result,
            timestamp: Date.now()
        });
        this.saveToStorage();
    }

    get(text) {
        const entry = this.cache.get(text);
        if (!entry) return null;

        // Check if cache entry has expired
        if (Date.now() - entry.timestamp > CACHE_EXPIRY) {
            this.cache.delete(text);
            this.saveToStorage();
            return null;
        }

        return entry.result;
    }

    loadFromStorage() {
        try {
            const stored = localStorage.getItem('profanityCache');
            if (stored) {
                const parsed = JSON.parse(stored);
                this.cache = new Map(Object.entries(parsed));
            }
        } catch (error) {
            debugLog('Error loading cache from storage:', error);
        }
    }

    saveToStorage() {
        try {
            const obj = Object.fromEntries(this.cache);
            localStorage.setItem('profanityCache', JSON.stringify(obj));
        } catch (error) {
            debugLog('Error saving cache to storage:', error);
        }
    }
}

const profanityCache = new ProfanityCache();

/**
 * Debug logging utility
 */
function debugLog(...args) {
    if (DEBUG) {
        console.log('[Profanity Blocker]', ...args);
    }
}

/**
 * Creates and injects the filter toggle button
 */
function createToggleButton() {
    const button = document.createElement('div');
    button.innerHTML = `
        <div id="profanity-filter-toggle" 
             style="position: fixed; bottom: 20px; right: 20px; 
                    background-color: #4CAF50; color: white; 
                    padding: 10px 20px; border-radius: 5px; 
                    cursor: pointer; z-index: 10000; 
                    box-shadow: 0 2px 5px rgba(0,0,0,0.2);">
            Filter: ON
        </div>
    `;
    document.body.appendChild(button);
    
    const toggleButton = document.getElementById('profanity-filter-toggle');
    toggleButton.addEventListener('click', () => {
        if (toggleButton.textContent.includes('ON')) {
            toggleButton.textContent = 'Filter: OFF';
            toggleButton.style.backgroundColor = '#f44336';
            disableFilter();
        } else {
            toggleButton.textContent = 'Filter: ON';
            toggleButton.style.backgroundColor = '#4CAF50';
            enableFilter();
        }
    });
}

/**
 * Debounce utility function
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Checks text for complex profanity using AI
 */
async function checkForComplexProfanity(text) {
    const cached = profanityCache.get(text);
    if (cached !== null) {
        return cached;
    }

    if (apiCallCount >= RPM_LIMIT) {
        debugLog('Rate limit reached, skipping AI check');
        return false;
    }

    if (!checkDailyLimit()) {
        debugLog('Daily limit reached, skipping AI check');
        return false;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
        apiCallCount++;
        
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{
                            text: `Analyze if this text contains hate speech, discrimination, threats, or severe profanity. Consider ALL of these categories as severe content:
                            1. Racial slurs or ethnic discrimination
                            2. Religious discrimination or attacks
                            3. Gender-based discrimination
                            4. Sexual orientation discrimination
                            5. Strong profanity or vulgar language
                            6. Threats of violence
                            7. Personal attacks or harassment
                            8. Hate speech of any kind
                            
                            Reply ONLY with "YES" if ANY severe content is found, "NO" if none is found.
                            
                            Text to analyze: "${text}"`
                        }]
                    }],
                    safetySettings: [
                        {
                            category: "HARM_CATEGORY_HARASSMENT",
                            threshold: "BLOCK_NONE"
                        },
                        {
                            category: "HARM_CATEGORY_HATE_SPEECH",
                            threshold: "BLOCK_NONE"
                        }
                    ]
                })
            }
        );

        if (!response.ok) {
        debugLog('API Response not OK:', response.status);
        let errorMessage = `API Error: ${response.status}`;
        try {
            const errorData = await response.json();
            errorMessage += ` - ${errorData.error.message || JSON.stringify(errorData)}`; // More detailed error
        } catch (jsonError) {
            errorMessage += ' - Could not parse error details.';
        }
        console.error(errorMessage); // Log to console for debugging
        // Optionally, display a message to the user (if appropriate for a content script)
        return false; // Return false to indicate no profanity detected
    }
        const data = await response.json();
        debugLog('API Response:', data);
        
        const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase();
        debugLog('AI Classification Result:', answer);
        
        const result = answer === 'YES';
        profanityCache.set(text, result);
        return result;
   } catch (error) {
    debugLog('API Error:', error);
    console.error('API request failed:', error);
    return false;
    }
}

/**
 * Style definitions for blur effect
 */
const style = document.createElement('style');
style.textContent = `
    .profanity-blur {
        filter: blur(5px);
        transition: filter 0.3s;
        cursor: pointer;
        display: inline-block;
    }
    
    .profanity-blur:hover {
        filter: none;
    }
`;
document.head.appendChild(style);

/**
 * Resets API rate limiting counter
 */
function resetRateLimit() {
    const now = Date.now();
    if (now - lastMinuteTimestamp >= 60000) {
        apiCallCount = 0;
        lastMinuteTimestamp = now;
    }
}

/**
 * Checks and manages daily rate limit
 * @returns {boolean} - True if within limits, false if exceeded
 */
function checkDailyLimit() {
    const now = Date.now();
    // Reset daily counter if 24 hours have passed
    if (now - dailyResetTimestamp >= 24 * 60 * 60 * 1000) {
        dailyRequestCount = 0;
        dailyResetTimestamp = now;
    }
    
    if (dailyRequestCount >= DAILY_LIMIT) {
        debugLog('Daily limit reached, request blocked');
        return false;
    }
    
    dailyRequestCount++;
    return true;
}

/**
 * Splits text into sentences
 */
function splitIntoSentences(text) {
    const prepared = text
        .replace(/([A-Z])\./g, '$1<DOT>')
        .replace(/([A-Z][a-z]{1,2})\./g, '$1<DOT>')
        .replace(/(Dr|Mr|Mrs|Ms|Prof|Sr|Jr|vs|etc|i\.e|e\.g)\./gi, '$1<DOT>');
    
    const sentences = prepared.split(/(?<=[.!?])\s+/);
    return sentences.map(s => s.replace(/<DOT>/g, '.').trim()).filter(Boolean);
}

/**
 * Finds profanity matches using regex patterns
 */
function findProfanityMatches(text) {
    const matches = [];
    
    for (const [lang, pattern] of Object.entries(languagePatterns)) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            matches.push({
                word: match[0],
                index: match.index,
                length: match[0].length,
                language: lang
            });
        }
    }
    
    return matches.sort((a, b) => a.index - b.index);
}

/**
 * Applies blur effect to text
 */
function blurText(textNode, matches = []) {
    const text = textNode.textContent;
    
    if (matches.length === 0) {
        const blurSpan = document.createElement('span');
        blurSpan.className = 'profanity-blur';
        blurSpan.textContent = text;
        textNode.parentNode.replaceChild(blurSpan, textNode);
        return true;
    }

    const container = document.createElement('span');
    let lastIndex = 0;

    matches.forEach(match => {
        if (match.index > lastIndex) {
            container.appendChild(
                document.createTextNode(text.slice(lastIndex, match.index))
            );
        }

        const blurSpan = document.createElement('span');
        blurSpan.className = 'profanity-blur';
        blurSpan.textContent = match.word;
        container.appendChild(blurSpan);

        lastIndex = match.index + match.length;
    });

    if (lastIndex < text.length) {
        container.appendChild(
            document.createTextNode(text.slice(lastIndex))
        );
    }

    textNode.parentNode.replaceChild(container, textNode);
    return true;
}

/**
 * Processes individual text nodes
 */
async function processTextNode(textNode) {
    if (!isEnabled || processedNodes.has(textNode)) return;

    const text = textNode.textContent.trim();
    if (!text) return;

    try {
        processedNodes.add(textNode);
        
        const profanityMatches = findProfanityMatches(text);
        if (profanityMatches.length > 0) {
            debugLog('Local detection found profanity:', text);
            blurText(textNode, profanityMatches);
            return;
        }

        if (text.length >= 5) {
            const isProfane = await checkForComplexProfanity(text);
            if (isProfane) {
                debugLog('AI detected hate speech in:', text);
                blurText(textNode);
                return;
            }
        }
    } catch (error) {
        debugLog('Error processing text node:', error);
    }
}

/**
 * Scans document for text nodes
 */
function scanDocument() {
    if (!isEnabled) return;
    
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode: function(node) {
                if (node.parentElement?.tagName === 'SCRIPT' || 
                    node.parentElement?.tagName === 'STYLE' ||
                    node.parentElement?.tagName === 'NOSCRIPT' ||
                    node.parentElement?.classList.contains('profanity-blur')) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    let nodeBatch = [];
    let node;
    while (node = walker.nextNode()) {
        nodeBatch.push(node);
        if (nodeBatch.length >= 5) {
            processBatch(nodeBatch);
            nodeBatch = [];
        }
    }
    if (nodeBatch.length > 0) {
        processBatch(nodeBatch);
    }
}

/**
 * Processes nodes in batches
 */
async function processBatch(nodes) {
    for (const node of nodes) {
        await processTextNode(node);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

/**
 * Enables the profanity filter
 */
function enableFilter() {
    isEnabled = true;
    scanDocument();
}

/**
 * Disables the profanity filter
 */
function disableFilter() {
    isEnabled = false;
    document.querySelectorAll('.profanity-blur').forEach(element => {
        const text = element.textContent;
        const textNode = document.createTextNode(text);
        element.parentNode.replaceChild(textNode, element);
    });
    processedNodes = new WeakSet();
}

// Initialize extension
createToggleButton();

// Perform initial scans with progressive delays
[100, 500, 1500, 3000].forEach(delay => {
    setTimeout(scanDocument, delay);
});

// Modify the mutation observer to use debouncing
const debouncedScanDocument = debounce(scanDocument, DEBOUNCE_DELAY);

// Update the observer
const observer = new MutationObserver((mutations) => {
    if (!isEnabled) return;
    
    if (mutations.some(mutation => mutation.addedNodes.length > 0)) {
        debouncedScanDocument();
    }
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});

debugLog('Enhanced multilingual extension v2.0 initialized with improved performance');
