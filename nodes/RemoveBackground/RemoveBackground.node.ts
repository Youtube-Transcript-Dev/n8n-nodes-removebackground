import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	IN8nHttpFullResponse,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

const BASE_URL = 'https://removebackground.dev';
const CREDENTIAL = 'removeBackgroundApi';
const POLL_INTERVAL_MS = 2000;
const POLL_ATTEMPTS = 60;

const EXTENSIONS: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
};

type ApiErrorBody = {
	error?: { code?: string; message?: string };
	errors?: Array<{ code?: string; title?: string; detail?: string }>;
};

function toBuffer(body: unknown): Buffer {
	if (Buffer.isBuffer(body)) return body;
	if (body instanceof ArrayBuffer) return Buffer.from(body);
	if (typeof body === 'string') return Buffer.from(body);
	return Buffer.from(JSON.stringify(body ?? {}));
}

function parseJson(body: unknown): IDataObject {
	try {
		return JSON.parse(toBuffer(body).toString('utf8')) as IDataObject;
	} catch {
		return {};
	}
}

function headerOf(res: IN8nHttpFullResponse, name: string): string | undefined {
	const value = res.headers[name.toLowerCase()];
	return Array.isArray(value) ? value[0] : (value as string | undefined);
}

function numberHeader(res: IN8nHttpFullResponse, name: string): number | null {
	const value = Number(headerOf(res, name));
	return headerOf(res, name) !== undefined && Number.isFinite(value) ? value : null;
}

async function call(
	ctx: IExecuteFunctions,
	itemIndex: number,
	options: IHttpRequestOptions,
): Promise<IN8nHttpFullResponse> {
	// Errors are read from the body ourselves: with arraybuffer encoding n8n would only show the bytes.
	let res: IN8nHttpFullResponse;
	try {
		res = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL, {
			...options,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			encoding: 'arraybuffer',
			json: false,
		})) as IN8nHttpFullResponse;
	} catch (error) {
		throw new NodeApiError(ctx.getNode(), error as JsonObject, { itemIndex });
	}
	if (res.statusCode < 400) return res;

	const body = parseJson(res.body) as ApiErrorBody & IDataObject;
	const compat = body.errors?.[0];
	const code = body.error?.code ?? compat?.code ?? 'error';
	const message = body.error?.message ?? [compat?.title, compat?.detail].filter(Boolean).join(': ');
	throw new NodeApiError(ctx.getNode(), body as JsonObject, {
		message: message || `Request failed with status ${res.statusCode}`,
		description: `removebackground.dev error code: ${code}`,
		httpCode: String(res.statusCode),
		itemIndex,
	});
}

function baseName(name: string | undefined): string {
	const last = (name ?? '').split(/[/?#]/).filter(Boolean).pop() ?? '';
	let decoded = last;
	try {
		decoded = decodeURIComponent(last);
	} catch {
		// Keep the raw segment when it isn't valid percent-encoding.
	}
	return decoded.replace(/\.[^.]+$/, '') || 'image';
}

async function removeBackground(ctx: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const source = ctx.getNodeParameter('source', i) as 'binary' | 'url';
	const options = ctx.getNodeParameter('options', i, {}) as {
		format?: string;
		bgColor?: string;
		size?: string;
		crop?: boolean;
	};
	const outputProperty = ctx.getNodeParameter('outputBinaryPropertyName', i, 'data') as string;

	const body: IDataObject = {};
	let originalName: string | undefined;
	if (source === 'binary') {
		const inputProperty = ctx.getNodeParameter('binaryPropertyName', i, 'data') as string;
		const binary = ctx.helpers.assertBinaryData(i, inputProperty);
		const bytes = await ctx.helpers.getBinaryDataBuffer(i, inputProperty);
		body.image_file_b64 = bytes.toString('base64');
		originalName = binary.fileName;
	} else {
		const imageUrl = (ctx.getNodeParameter('imageUrl', i) as string).trim();
		if (!/^https?:\/\//i.test(imageUrl)) {
			throw new NodeOperationError(ctx.getNode(), 'Image URL must start with http:// or https://', {
				itemIndex: i,
			});
		}
		body.image_url = imageUrl;
		originalName = imageUrl;
	}
	if (options.format) body.format = options.format;
	if (options.bgColor) body.bg_color = options.bgColor;
	if (options.size) body.size = options.size;
	if (options.crop !== undefined) body.crop = options.crop;

	let res = await call(ctx, i, {
		method: 'POST',
		url: `${BASE_URL}/v1/remove`,
		headers: { 'Content-Type': 'application/json', Accept: 'image/*, application/json' },
		body: JSON.stringify(body),
	});

	let jobId = headerOf(res, 'x-job-id');
	if (res.statusCode === 202) {
		jobId = String(parseJson(res.body).id ?? jobId ?? '');
		if (!jobId) throw new NodeOperationError(ctx.getNode(), 'The API answered 202 without a job id', { itemIndex: i });
		res = await waitForResult(ctx, i, jobId);
	}

	const mimeType = (headerOf(res, 'content-type') ?? 'image/png').split(';')[0].trim();
	const extension = EXTENSIONS[mimeType] ?? 'png';
	const fileName = `${baseName(originalName)}-no-bg.${extension}`;
	const binaryData = await ctx.helpers.prepareBinaryData(toBuffer(res.body), fileName, mimeType);

	return {
		json: {
			width: numberHeader(res, 'x-width'),
			height: numberHeader(res, 'x-height'),
			credits_remaining: numberHeader(res, 'x-credits-remaining'),
			format: extension,
			file_name: fileName,
			job_id: jobId ?? null,
			removal_id: headerOf(res, 'x-removal-id') ?? null,
		},
		binary: { [outputProperty]: binaryData },
		pairedItem: { item: i },
	};
}

async function waitForResult(
	ctx: IExecuteFunctions,
	i: number,
	jobId: string,
): Promise<IN8nHttpFullResponse> {
	// Job URLs are built from the id, not taken from the response, so the API key only goes to BASE_URL.
	const jobUrl = `${BASE_URL}/v1/jobs/${encodeURIComponent(jobId)}`;
	for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
		await sleep(POLL_INTERVAL_MS);
		const status = parseJson((await call(ctx, i, { method: 'GET', url: jobUrl })).body);
		if (status.done === true) return await call(ctx, i, { method: 'GET', url: `${jobUrl}/result` });
	}
	throw new NodeOperationError(
		ctx.getNode(),
		`The image is still processing after ${(POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000} seconds`,
		{ itemIndex: i, description: `Check the job later at ${jobUrl}` },
	);
}

async function getCredits(ctx: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const res = await call(ctx, i, { method: 'GET', url: `${BASE_URL}/v1.0/account` });
	const attributes = ((parseJson(res.body).data as IDataObject | undefined)?.attributes ??
		{}) as IDataObject;
	const credits = (attributes.credits ?? {}) as IDataObject;
	return { json: { credits: (credits.total as number) ?? null }, pairedItem: { item: i } };
}

export class RemoveBackground implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'removebackground.dev',
		name: 'removeBackground',
		// The logo is a solid square that reads on both themes.
		icon: { light: 'file:removebackground.svg', dark: 'file:removebackground.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"]}}',
		description: 'Remove the background from images with removebackground.dev',
		defaults: {
			name: 'removebackground.dev',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: CREDENTIAL, required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Get Credits',
						value: 'getCredits',
						description: 'Get the credit balance of the account',
						action: 'Get credits',
					},
					{
						name: 'Remove Background',
						value: 'removeBackground',
						description: 'Remove the background from an image',
						action: 'Remove background',
					},
				],
				default: 'removeBackground',
			},
			{
				displayName: 'Input Source',
				name: 'source',
				type: 'options',
				options: [
					{ name: 'Binary File', value: 'binary' },
					{ name: 'Image URL', value: 'url' },
				],
				default: 'binary',
				displayOptions: { show: { operation: ['removeBackground'] } },
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				hint: 'The name of the input binary field containing the image',
				displayOptions: { show: { operation: ['removeBackground'], source: ['binary'] } },
			},
			{
				displayName: 'Image URL',
				name: 'imageUrl',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://example.com/photo.jpg',
				description: 'Public URL of a JPG, PNG or WebP image',
				displayOptions: { show: { operation: ['removeBackground'], source: ['url'] } },
			},
			{
				displayName: 'Output Binary Field',
				name: 'outputBinaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				hint: 'The name of the output binary field to put the result image in',
				displayOptions: { show: { operation: ['removeBackground'] } },
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { operation: ['removeBackground'] } },
				options: [
					{
						displayName: 'Background Color',
						name: 'bgColor',
						type: 'color',
						default: '',
						placeholder: '#ffffff',
						description: 'Fill the background with this color instead of leaving it transparent',
					},
					{
						displayName: 'Crop to Subject',
						name: 'crop',
						type: 'boolean',
						default: false,
						description: 'Whether to crop the result to the subject',
					},
					{
						displayName: 'Format',
						name: 'format',
						type: 'options',
						options: [
							{ name: 'JPG', value: 'jpg' },
							{ name: 'PNG', value: 'png' },
							{ name: 'WebP', value: 'webp' },
						],
						default: 'png',
						description: 'File format of the result. JPG has no transparency.',
					},
					{
						displayName: 'Size',
						name: 'size',
						type: 'options',
						options: [
							{ name: 'Full', value: 'full', description: 'Original resolution' },
							{ name: 'HD', value: 'hd' },
							{ name: 'Medium', value: 'medium' },
							{ name: 'Preview', value: 'preview' },
						],
						default: 'full',
						description: 'Maximum output size',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				returnData.push(
					operation === 'getCredits' ? await getCredits(this, i) : await removeBackground(this, i),
				);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// Both constructors hand back an error that is already of their type unchanged.
				if (error instanceof NodeApiError) {
					throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex: i });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
