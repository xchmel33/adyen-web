import { mockResponse } from './packages/lib/src/core/Services/mockResponse.js';
import fs from 'fs';

const testResponse = JSON.parse(fs.readFileSync('testResponse.json', 'utf8'));
const endpoint = 'checkoutshopper-test.adyen.com/checkoutshopper/v1/sessions/CS64220A22418B1B1A/setup';
const method = 'POST';
const params = { clientKey: 'test_SNY6SRDLZVGH3B2I53CCV2YK6YIOK4H7' };
const data = { paymentMethod: { type: 'scheme', number: '4111111111111111', expiryMonth: '10', expiryYear: '2023', cvc: '737' } };
const httpClient = () => testResponse;
const mockConfig = { client: true, recording: true, all_unique: true, indexing: true, testName: 'test' };

// endpoint, method, params, data, httpClient, mockConfig
const result = mockResponse({
    endpoint,
    method,
    params,
    data,
    httpClient,
    mockConfig
});
console.log(result);
