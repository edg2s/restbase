'use strict';

/**
 * Pageviews API module
 *
 * This API serves pre-aggregated pageview statistics from Cassandra
 */

var URI = require('swagger-router').URI;

var fs = require('fs');
var yaml = require('js-yaml');
var path = require('path');
var spec = yaml.safeLoad(fs.readFileSync(path.join(__dirname, '/pageviews.yaml')));
var HTTPError = require('../lib/exports').HTTPError;


// Pageviews Service
function PJVS(options) {
    this.options = options;
}


var tables = {
    articleFlat: 'pageviews.per.article.flat',
    project: 'pageviews.per.project',
    tops: 'top.pageviews',
};
var tableURI = function(domain, tableName) {
    return new URI([domain, 'sys', 'table', tableName, '']);
};
var tableSchemas = {
    articleFlat: {
        table: tables.articleFlat,
        version: 2,
        attributes: {
            project: 'string',
            article: 'string',
            granularity: 'string',
            // the hourly timestamp will be stored as YYYYMMDDHH
            timestamp: 'string'

            // The various int columns that hold view counts are added below
        },
        index: [
            { attribute: 'project', type: 'hash' },
            { attribute: 'article', type: 'hash' },
            { attribute: 'granularity', type: 'hash' },
            { attribute: 'timestamp', type: 'range', order: 'asc' },
        ],
        options: {
            updates: {
                pattern: 'timeseries'
            }
        }
    },
    project: {
        table: tables.project,
        version: 2,
        attributes: {
            project: 'string',
            access: 'string',
            agent: 'string',
            granularity: 'string',
            // the hourly timestamp will be stored as YYYYMMDDHH
            timestamp: 'string',
            views: 'int',
            v: 'long'
        },
        index: [
            { attribute: 'project', type: 'hash' },
            { attribute: 'access', type: 'hash' },
            { attribute: 'agent', type: 'hash' },
            { attribute: 'granularity', type: 'hash' },
            { attribute: 'timestamp', type: 'range', order: 'asc' },
        ]
    },
    tops: {
        table: tables.tops,
        version: 2,
        attributes: {
            project: 'string',
            access: 'string',
            year: 'string',
            month: 'string',
            day: 'string',
            // this is deprecated, it used to be json stringified to look like:
            // [{\"rank\": 1, \"article\": \"<<title>>\", \"views\": 123}, ...]
            articles: 'string',
            // this will be preferred to articles and uses the same format
            articlesJSON: 'json'
        },
        index: [
            { attribute: 'project', type: 'hash' },
            { attribute: 'access', type: 'hash' },
            { attribute: 'year', type: 'hash' },
            { attribute: 'month', type: 'hash' },
            { attribute: 'day', type: 'hash' },
        ]
    }
};


var viewCountColumnsForArticleFlat = {
    views_all_access_all_agents: 'aa', // views for all-access, all-agents
    views_all_access_bot: 'ab',        // views for all-access, bot
    views_all_access_spider: 'as',     // views for all-access, spider
    views_all_access_user: 'au',       // views for all-access, user

    views_desktop_all_agents: 'da',    // views for desktop, all-agents
    views_desktop_bot: 'db',           // views for desktop, bot
    views_desktop_spider: 'ds',        // views for desktop, spider
    views_desktop_user: 'du',          // views for desktop, user

    views_mobile_app_all_agents: 'maa', // views for mobile-app, all-agents
    views_mobile_app_bot: 'mab',        // views for mobile-app, bot
    views_mobile_app_spider: 'mas',     // views for mobile-app, spider
    views_mobile_app_user: 'mau',       // views for mobile-app, user

    views_mobile_web_all_agents: 'mwa', // views for mobile-web, all-agents
    views_mobile_web_bot: 'mwb',        // views for mobile-web, bot
    views_mobile_web_spider: 'mws',     // views for mobile-web, spider
    views_mobile_web_user: 'mwu'        // views for mobile-web, user
};

// in the pageviews.per.article.flat table, make an integer column for each
// view count column in the dictionary above, using its short name.
// The short name saves space because cassandra stores the column name with
// each record.
Object.keys(viewCountColumnsForArticleFlat).forEach(function(k) {
    tableSchemas.articleFlat.attributes[viewCountColumnsForArticleFlat[k]] = 'int';
});

var notFoundCatcher = function(e) {
    if (e.status === 404) {
        e.body.description = 'The date(s) you used are valid, but we either do ' +
                             'not have data for those date(s), or the project ' +
                             'you asked for is not loaded yet.  Please check ' +
                             'https://wikimedia.org/api/rest_v1/?doc for more ' +
                             'information.';
        e.body.type = 'not_found';
    }
    throw e;
};

/**
 * general handler functions */
var normalizeResponse = function(res) {
    // always return at least an empty array so that queries for non-existing data don't error
    res = res || {};
    res.body = res.body || { items: [] };
    res.headers = res.headers || {};
    res.headers['cache-control'] = 's-maxage=3600, max-age=3600';
    return res;
};

/**
 * Parameter validators
 */
var throwIfNeeded = function(errors) {
    if (errors && errors.length) {
        throw new HTTPError({
            status: 400,
            body: {
                type: 'invalid_request',
                detail: errors,
            }
        });
    }
};

/**
 * Cleans the project parameter so it can be passed in as either en.wikipedia.org or en.wikipedia
 */
var stripOrgFromProject = function(rp) {
    rp.project = rp.project.replace(/\.org$/, '');
};


var validateTimestamp = function(timestamp, opts) {
    opts = opts || {};

    if (timestamp && timestamp.length > 10) {
        return false;
    }

    try {
        var year = timestamp.substring(0, 4);
        var month = timestamp.substring(4, 6);
        var day = timestamp.substring(6, 8);
        var hour = opts.fakeHour ? '00' : timestamp.substring(8, 10);

        var dt = new Date([year, month, day].join('-') + ' ' + hour + ':00:00 UTC');

        return dt.toString() !== 'Invalid Date'
            && dt.getUTCFullYear() === parseInt(year, 10)
            && dt.getUTCMonth() === (parseInt(month, 10) - 1)
            && dt.getUTCDate() === parseInt(day, 10)
            && dt.getUTCHours() === parseInt(hour);

    } catch (e) {
        return false;
    }
};


var validateStartAndEnd = function(rp, opts) {
    opts = opts || {};

    var errors = [];
    var invalidMessage = opts.fakeHour ?
       'invalid, must be a valid date in YYYYMMDD format' :
       'invalid, must be a valid timestamp in YYYYMMDDHH format';

    stripOrgFromProject(rp);

    if (!validateTimestamp(rp.start, opts)) {
        errors.push('start timestamp is ' + invalidMessage);
    }
    if (!validateTimestamp(rp.end, opts)) {
        errors.push('end timestamp is ' + invalidMessage);
    }

    if (rp.start > rp.end) {
        errors.push('start timestamp should be before the end timestamp');
    }

    throwIfNeeded(errors);
};

var validateYearMonthDay = function(rp) {
    var errors = [];

    stripOrgFromProject(rp);

    if (rp.month === 'all-months' && rp.day !== 'all-days') {
        errors.push('day must be "all-days" when passing "all-months"');
    }

    // the errors above are better by themselves, so throw them if they're there
    throwIfNeeded(errors);

    // fake a timestamp in the YYYYMMDDHH format so we can reuse the validator
    var validDate = validateTimestamp(
        rp.year +
        ((rp.month === 'all-months') ? '01' : rp.month) +
        ((rp.day === 'all-days') ? '01' : rp.day) +
        '00'
    );

    if (!validDate) {
        var invalidPieces = [];
        if (rp.month !== 'all-months') { invalidPieces.push('month'); }
        if (rp.day !== 'all-days') { invalidPieces.push('day'); }

        errors.push(
            invalidPieces.join(', ') +
            (invalidPieces.length > 1 ? ' are' : ' is') +
            ' invalid'
        );
    }

    throwIfNeeded(errors);
};

PJVS.prototype.pageviewsForArticleFlat = function(hyper, req) {
    var rp = req.params;

    // dates are passed in as YYYYMMDD but we need the HH to match the loaded data
    // which was originally planned at hourly resolution, so we pass "fakeHour"
    validateStartAndEnd(rp, { fakeHour: true });

    var dataRequest = hyper.get({
        uri: tableURI(rp.domain, tables.articleFlat),
        body: {
            table: tables.articleFlat,
            attributes: {
                project: rp.project,
                article: rp.article,
                granularity: rp.granularity,
                timestamp: { between: [rp.start, rp.end] },
            }
        }

    }).catch(notFoundCatcher);

    function viewKey(access, agent) {
        var ret = ['views', access, agent].join('_');
        return viewCountColumnsForArticleFlat[ret.replace(/-/g, '_')];
    }

    function removeDenormalizedColumns(item) {
        Object.keys(viewCountColumnsForArticleFlat).forEach(function(k) {
            delete item[viewCountColumnsForArticleFlat[k]];
        });
    }

    return dataRequest.then(normalizeResponse).then(function(res) {
        if (res.body.items) {
            res.body.items.forEach(function(item) {
                item.access = rp.access;
                item.agent = rp.agent;
                item.views = item[viewKey(rp.access, rp.agent)];
                removeDenormalizedColumns(item);
            });
        }

        return res;
    });
};

PJVS.prototype.pageviewsForProjects = function(hyper, req) {
    var rp = req.params;

    validateStartAndEnd(rp);

    var dataRequest = hyper.get({
        uri: tableURI(rp.domain, tables.project),
        body: {
            table: tables.project,
            attributes: {
                project: rp.project,
                access: rp.access,
                agent: rp.agent,
                granularity: rp.granularity,
                timestamp: { between: [rp.start, rp.end] },
            }
        }

    }).catch(notFoundCatcher);

    return dataRequest.then(normalizeResponse).then(function(res) {
        if (res.body.items) {
            res.body.items.forEach(function(item) {
                // prefer the v column if it's loaded
                if (item.v !== null) {
                    try {
                        item.views = parseInt(item.v, 10);
                    } catch (e) {
                        item.views = null;
                    }
                }
                delete item.v;
            });
        }

        return res;
    });
};

PJVS.prototype.pageviewsForTops = function(hyper, req) {
    var rp = req.params;

    validateYearMonthDay(rp);

    var dataRequest = hyper.get({
        uri: tableURI(rp.domain, tables.tops),
        body: {
            table: tables.tops,
            attributes: {
                project: rp.project,
                access: rp.access,
                year: rp.year,
                month: rp.month,
                day: rp.day
            }
        }

    }).catch(notFoundCatcher);

    return dataRequest.then(normalizeResponse).then(function(res) {
        if (res.body.items) {
            res.body.items.forEach(function(item) {
                // prefer the articlesJSON column if it's loaded
                if (item.articlesJSON !== null) {
                    item.articles = item.articlesJSON;
                } else {
                    try {
                        item.articles = JSON.parse(item.articles);
                    } catch (e) {
                        throw new HTTPError({
                            status: 500,
                            body: {
                                type: 'error',
                                description: 'This response contained invalid JSON, we are ' +
                                    'working on fixing the problem, but until then you can ' +
                                    'try a different date.'
                            }
                        });
                    }
                }
                delete item.articlesJSON;
            });
        }

        return res;
    });
};


module.exports = function(options) {
    var pjvs = new PJVS(options);

    return {
        spec: spec,
        operations: {
            pageviewsForArticle: pjvs.pageviewsForArticleFlat.bind(pjvs),
            pageviewsForProjects: pjvs.pageviewsForProjects.bind(pjvs),
            pageviewsForTops: pjvs.pageviewsForTops.bind(pjvs),
        },
        resources: [
            {
                uri: '/{domain}/sys/table/' + tables.articleFlat,
                body: tableSchemas.articleFlat,
            }, {
                // pageviews per project table
                uri: '/{domain}/sys/table/' + tables.project,
                body: tableSchemas.project,
            }, {
                // top pageviews table
                uri: '/{domain}/sys/table/' + tables.tops,
                body: tableSchemas.tops,
            }
        ]
    };
};
