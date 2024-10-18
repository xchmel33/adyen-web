import { chain, pickBy } from 'lodash';
import { httpGet, httpPost } from './http.js';
import SparkMD5 from 'spark-md5';
const uniqueKeyBlacklist = ['GWCLIENTID', 'appUid', 'prorated_price', 'id', 'created_at'];
const uniqueResponseBlacklist = ['account/settings/', 'magic-login/'];
const maxFilenameLength = 175;

function md5(data) {
    return SparkMD5.hash(data);
}

const extractTopLevelObject = str => {
    let depth = 0;
    let objectStart = -1;
    let objectEnd = -1;

    for (let i = 0; i < str.length; i++) {
        if (str[i] === '{' || str[i] === '[') {
            depth++;
            if (depth === 1) {
                objectStart = i;
            }
        } else if (str[i] === '}' || str[i] === ']') {
            if (depth === 1) {
                objectEnd = i;
                break;
            }
            depth--;
        }
    }

    if (objectStart === -1 || objectEnd === -1) {
        return null;
    }
    let res = str.substring(objectStart, objectEnd + 1);
    let newStr = str.replace(res, '');
    let longest = extractTopLevelObject(newStr);
    while (longest && res) {
        if (longest.length > res.length) {
            res = longest;
        }
        newStr = newStr.replace(longest, '');
        longest = extractTopLevelObject(newStr);
    }
    return res;
};

const sanitizeFileName = fileName => {
    fileName = `${fileName.replace(/"/g, '').replace(/:/g, '=').replace(/\//g, '-').replace('-_', '_')}.json`;

    const replaceTopLevelObject = str => {
        const topLevelObj = extractTopLevelObject(str);
        if (!topLevelObj) {
            return false;
        }
        const hash = md5(topLevelObj);
        if (topLevelObj.length <= hash.length) {
            return false;
        }
        return str.replace(topLevelObj, hash);
    };

    let newFileName = fileName;
    while (newFileName.length > maxFilenameLength) {
        const objectBody = newFileName.match(/\{(.*)\}/)[1];
        if (!objectBody) {
            break;
        }
        const newObjectBody = replaceTopLevelObject(objectBody);
        if (!newObjectBody) {
            break;
        }
        newFileName = newFileName.replace(objectBody, newObjectBody);
    }
    if (newFileName.length > maxFilenameLength) {
        newFileName = replaceTopLevelObject(fileName);
    }
    return `${newFileName}${newFileName.includes('.json') ? '' : '.json'}`;
};
const sortParams = params =>
    chain(params)
        .keys()
        .sort()
        .reduce((result, key) => ({ ...result, [key]: params[key] }), {})
        .value();

const generateCacheId = ({ endpoint, method, params, data, publicId, mockPrefixKey }) => {
    const cleanParams = params && sortParams(params);
    const cleanData = data && sortParams(data);

    if (endpoint.includes('magic-login')) {
        publicId = '';
    }

    return [
        mockPrefixKey,
        publicId,
        localStorage.getItem('loginPreset'),
        endpoint,
        method.toUpperCase(),
        cleanParams && JSON.stringify(pickBy(cleanParams, param => !!param?.toString())),
        cleanData && JSON.stringify(cleanData)
    ]
        .filter(x => x)
        .join('_');
};

async function automockApp({ method = 'POST', url, data }) {
    url = `http://localhost:3001/${url}`;
    try {
        let response;

        if (method === 'GET') {
            response = await httpGet({ path: url, loadingContext: '' }, null, false);
            // console.debug(`Response from ${url}:`, response)
            return response?.data || response;
        } // Assumes 'POST' by default
        // console.debug(`Response from ${url}:`, response)
        response = await httpPost({ path: url, loadingContext: '' }, data, false);
        return response?.data || response;
    } catch (e) {
        console.warn('Error in automockApp:', e);
        return false;
    }
}
const getRequestIndex = id => {
    const usedCacheIds = JSON.parse(localStorage.getItem('usedMockRequestCacheIds') || '[]');
    if (usedCacheIds.includes(id)) {
        let suffix = 1;
        const regex = new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}~([0-9]+)?`);
        usedCacheIds.forEach(usedCacheId => {
            const match = usedCacheId.match(regex);
            if (match && match[1]) {
                const currentSuffix = parseInt(match[1], 10);
                if (currentSuffix >= suffix) {
                    suffix = currentSuffix + 1;
                }
            }
        });
        id = `${id}~${suffix}`;
    }
    localStorage.setItem('usedMockRequestCacheIds', JSON.stringify([...usedCacheIds, id]));
    return id;
};
const isFloat = str => {
    if (!str) return false;
    str = str.toString();
    if (!isNaN(str) && !isNaN(parseFloat(str))) {
        return str.includes('.');
    }
    return false;
};
const parseValue = value => {
    if (isFloat(value)) {
        return parseFloat(parseFloat(value).toFixed(3));
    }
    return value;
};
const isObject = object => object != null && typeof object === 'object';
const deepEqual = (mockResponse, devResponse) => {
    let result = true;
    // this should prevent expired session errors
    if (!mockResponse.isError && devResponse.isError) return true;
    Object.keys(mockResponse).forEach(key => {
        const val1 = parseValue(mockResponse[key]);
        const val2 = parseValue(devResponse[key]);
        if (uniqueKeyBlacklist.includes(key) || typeof val2 === 'function') {
            // console.debug('Skipped key:', key)
            return;
        }
        const areObjects = isObject(val1) && isObject(val2);
        if ((areObjects && !deepEqual(val1, val2)) || (!areObjects && val1 !== val2)) {
            // if (!areObjects) console.debug(`At ${key} values ${val1} and ${val2} do not match`)
            result = false;
        }
    });

    return result;
};

const getMockPrefixKey = testName => {
    const split = testName.split('/');
    if (!split.length) return md5(testName);
    const prefix = split[split.length - 1];
    return md5(prefix);
};

export async function mockResponse({ endpoint, method, params, data, httpClient, mockConfig }) {
    let cacheId = generateCacheId({
        endpoint,
        method,
        params,
        data
    });
    const mocks = await automockApp({
        method: 'GET',
        url: `getResponseIndex`
    });
    if (!mockConfig || !mockConfig.client) {
        console.warn('Mock config missing in localstorage, mocks are disabled');
        return httpClient();
    }
    if (mockConfig.indexing) {
        cacheId = getRequestIndex(cacheId);
    }
    const testName = localStorage.getItem('testName') || '';
    let filename = sanitizeFileName(cacheId);
    let isUnique = false;
    const requestId = endpoint
        .split(/\//)
        .filter(x => x)
        .join('-');

    const mockPrefixKey = getMockPrefixKey(testName);
    const cacheParams = {
        endpoint,
        method,
        params,
        data,
        mockPrefixKey
    };
    const uniqueCacheId = generateCacheId(cacheParams);
    const uniqueFilename = sanitizeFileName(uniqueCacheId);
    // check if unique response exists
    if (mocks && uniqueFilename in mocks) {
        const result = await automockApp({
            method: 'POST',
            url: `getMockResponse?id=${requestId}&filename=${uniqueFilename}&testName=${testName}&updateIndex=${mockConfig.recording}`,
            data
        });
        if (!result || result.status === 404) {
            console.warn(`Error getting unique mock response ${uniqueCacheId}. Will call backend server & save new.`);
            filename = uniqueFilename;
            cacheId = uniqueCacheId;
            isUnique = true;
        } else {
            return result.isError
                ? { error: result, response: null }
                : {
                      error: null,
                      response: result
                  };
        }
    }

    // check if classic response exists
    else if (mocks && filename in mocks) {
        const result = await automockApp({
            method: 'POST',
            url: `getMockResponse?id=${requestId}&filename=${filename}&testName=${testName}&updateIndex=${mockConfig.recording}`,
            data
        });

        // compare the result with backend server in recording mode
        if (mockConfig.recording && !mocks[filename].tests.includes(testName)) {
            let { response, error } = await httpClient();
            if (error) {
                delete error.toJSON;
                console.warn('Error in apiCallRes:', error);
            }
            response = {
                isError: !!error,
                ...(response || error)
            };
            if (!uniqueResponseBlacklist.includes(endpoint) && !deepEqual(result, JSON.parse(JSON.stringify(response)))) {
                await automockApp({
                    url: `saveResponse?id=${requestId}`,
                    data: {
                        cacheId: uniqueCacheId,
                        cacheParams,
                        filename: uniqueFilename,
                        testName,
                        response,
                        error,
                        isUnique: true
                    }
                });
                return { response, error };
            }
        }

        if (!result || result.status === 404) {
            console.error(`Error getting mock response ${cacheId}. Will call backend server & save new.`);
        } else {
            return result.isError
                ? { error: result, response: null }
                : {
                      error: null,
                      response: result
                  };
        }
    }

    if (!mockConfig.recording) {
        await automockApp({
            url: 'consoleWarn',
            data: {
                message: `Missing mock ${filename}:\n ${JSON.stringify(cacheParams)}\n request cancelled!`,
                type: 'cancelled request'
            }
        });
        return { response: null, error: { canceled: true } };
    }

    // call backend server
    const response = await httpClient();
    // console.debug('response from http:', response)

    // save response
    if (
        await automockApp({
            url: `saveResponse?id=${requestId}`,
            data: {
                cacheId,
                cacheParams,
                filename,
                testName,
                response,
                error: null,
                isUnique
            }
        })
    ) {
        // console.debug(`Saved mock response ${cacheId}`);
    } else {
        console.error(`Error saving mock response ${cacheId}`);
    }
    return response;
}
