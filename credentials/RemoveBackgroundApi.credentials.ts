import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class RemoveBackgroundApi implements ICredentialType {
	name = 'removeBackgroundApi';

	displayName = 'removebackground.dev API';

	icon: Icon = {
		light: 'file:../nodes/RemoveBackground/removebackground.svg',
		dark: 'file:../nodes/RemoveBackground/removebackground.dark.svg',
	};

	documentationUrl = 'https://removebackground.dev/api-keys';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Create a key on https://removebackground.dev/api-keys',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-Api-Key': '={{$credentials.apiKey}}',
			},
		},
	};

	// The account endpoint is free and only answers for a valid key.
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://removebackground.dev',
			url: '/v1.0/account',
			method: 'GET',
		},
	};
}
