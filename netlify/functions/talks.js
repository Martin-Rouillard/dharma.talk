const fs = require('fs');
const path = require('path');

// Load talks data once at cold start
let talksData = null;

function loadTalks() {
    if (!talksData) {
        const filePath = path.join(__dirname, '../../db/dharmaseed_talks.json');
        const data = fs.readFileSync(filePath, 'utf8');
        talksData = JSON.parse(data);
    }
    return talksData;
}

exports.handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300' // 5 min cache
    };

    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    try {
        const talks = loadTalks();
        const params = event.queryStringParameters || {};
        
        // Parse parameters
        const limit = Math.min(parseInt(params.limit) || 50, 500); // Max 500
        const offset = parseInt(params.offset) || 0;
        const teacherId = params.teacher_id ? parseInt(params.teacher_id) : null;
        const search = params.search ? params.search.toLowerCase() : null;
        const talkId = params.id ? parseInt(params.id) : null;
        
        // If requesting a specific talk by ID
        if (talkId) {
            const talk = talks.find(t => t.id === talkId);
            if (talk) {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ talk })
                };
            } else {
                return {
                    statusCode: 404,
                    headers,
                    body: JSON.stringify({ error: 'Talk not found' })
                };
            }
        }
        
        // Filter talks
        let filtered = talks;
        
        if (teacherId) {
            filtered = filtered.filter(t => t.teacher_id === teacherId);
        }
        
        if (search) {
            const searchNormalized = search.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            filtered = filtered.filter(t => {
                const title = (t.title || '').toLowerCase();
                const titleNorm = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                const desc = (t.description || '').toLowerCase();
                const descNorm = desc.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                
                return title.includes(search) || 
                       titleNorm.includes(searchNormalized) ||
                       desc.includes(search) ||
                       descNorm.includes(searchNormalized);
            });
        }
        
        // Get total count before pagination
        const total = filtered.length;
        
        // Apply pagination (talks are already sorted by date desc in the JSON)
        const paginated = filtered.slice(offset, offset + limit);
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                talks: paginated,
                total,
                limit,
                offset,
                hasMore: offset + limit < total
            })
        };
        
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error' })
        };
    }
};
