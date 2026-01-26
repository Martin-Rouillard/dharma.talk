const fs = require('fs');
const path = require('path');

// Load talks data once at cold start
let talksData = null;
let teachersMap = null;

function loadTalks() {
    if (!talksData) {
        const filePath = path.join(__dirname, '../../db/dharmaseed_talks.json');
        const data = fs.readFileSync(filePath, 'utf8');
        talksData = JSON.parse(data);
    }
    return talksData;
}

function loadTeachers() {
    if (!teachersMap) {
        const filePath = path.join(__dirname, '../../db/dharmaseed_teachers.json');
        const data = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(data);
        // Create a map of teacher_id -> teacher name for fast lookup
        teachersMap = {};
        (parsed.teachers || []).forEach(t => {
            teachersMap[t.id] = t.name || '';
        });
    }
    return teachersMap;
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
        const teachers = loadTeachers();
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
        
        // Filter by recording type (talk, meditation, other)
        const recordingType = params.recording_type ? params.recording_type.toLowerCase() : null;
        if (recordingType) {
            filtered = filtered.filter(t => {
                const type = (t.recording_type || '').toLowerCase();
                if (recordingType === 'talk') {
                    return type === 'talk';
                } else if (recordingType === 'meditation') {
                    return type === 'meditation' || type === 'guided meditation';
                } else if (recordingType === 'other') {
                    return type !== 'talk' && type !== 'meditation' && type !== 'guided meditation';
                }
                return true;
            });
        }
        
        if (search) {
            // Split search into terms for AND logic (e.g., "sucitto 2023" finds talks with both)
            const searchTerms = search.split(/\s+/).filter(term => term.length > 0);
            
            filtered = filtered.filter(t => {
                const title = (t.title || '').toLowerCase();
                const titleNorm = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                const desc = (t.description || '').toLowerCase();
                const descNorm = desc.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                const teacherName = (teachers[t.teacher_id] || '').toLowerCase();
                const teacherNorm = teacherName.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                const date = (t.rec_date || '').toLowerCase();
                
                // All search terms must match (AND logic)
                return searchTerms.every(term => {
                    const termNorm = term.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                    return title.includes(term) || 
                           titleNorm.includes(termNorm) ||
                           desc.includes(term) ||
                           descNorm.includes(termNorm) ||
                           teacherName.includes(term) ||
                           teacherNorm.includes(termNorm) ||
                           date.includes(term);
                });
            });
        }
        
        // Get total count before pagination
        const total = filtered.length;
        
        // Sort by date (most recent first)
        filtered.sort((a, b) => (b.rec_date || '').localeCompare(a.rec_date || ''));
        
        // Apply pagination
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
