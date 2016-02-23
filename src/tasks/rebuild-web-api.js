/*global module, require */
var aws = require('aws-sdk'),
	Promise = require('bluebird'),
	templateFile = require('../util/template-file'),
	validHttpCode = require('../util/valid-http-code'),
	allowApiInvocation = require('./allow-api-invocation'),
	fs = Promise.promisifyAll(require('fs'));
module.exports = function rebuildWebApi(functionName, functionVersion, restApiId, requestedConfig, awsRegion) {
	'use strict';
	var iam = Promise.promisifyAll(new aws.IAM()),
		apiGateway = Promise.promisifyAll(new aws.APIGateway({region: awsRegion})),
		apiConfig,
		existingResources,
		rootResourceId,
		ownerId,
		inputTemplateJson,
		inputTemplateForm,
		getOwnerId = function () {
			return iam.getUserAsync().then(function (result) {
				ownerId = result.User.Arn.split(':')[4];
			});
		},
		findByPath = function (resourceItems, path) {
			var result;
			resourceItems.forEach(function (item) {
				if (item.path === path) {
					result = item;
				}
			});
			return result;
		},
		getExistingResources = function () {
			return apiGateway.getResourcesAsync({restApiId: restApiId, limit: 499});
		},
		findRoot = function () {
			var rootResource = findByPath(existingResources, '/');
			rootResourceId = rootResource.id;
			return rootResourceId;
		},
		createMethod = function (methodName, resourceId, methodOptions) {
			var errorCode = function () {
					if (!methodOptions.error) {
						return '500';
					}
					if (validHttpCode(methodOptions.error)) {
						return String(methodOptions.error);
					}
					if (methodOptions.error && methodOptions.error.code && validHttpCode(methodOptions.error.code)) {
						return String(methodOptions.error.code);
					}
					return '500';
				},
				successCode = function () {
					if (!methodOptions.success) {
						return '200';
					}
					if (validHttpCode(methodOptions.success)) {
						return String(methodOptions.success);
					}
					if (methodOptions.success && methodOptions.success.code && validHttpCode(methodOptions.success.code)) {
						return String(methodOptions.success.code);
					}
					return '200';
				},
				isRedirect = function (code) {
					return /3[0-9][0-9]/.test(code);
				},
				errorContentType = function () {
					return methodOptions && methodOptions.error && methodOptions.error.contentType;
				},
				successContentType = function () {
					return methodOptions && methodOptions.success && methodOptions.success.contentType;
				},
				successTemplate = function () {
					var contentType = successContentType();
					if (!contentType || contentType === 'application/json') {
						return '';
					}
					return '$input.path(\'$\')';
				},
				errorTemplate = function () {
					var contentType = errorContentType();
					if (!contentType || contentType === 'application/json') {
						return '';
					}
					return '$input.path(\'$.errorMessage\')';
				},
				addCodeMapper = function (response) {
					var methodResponseParams = {
							'method.response.header.Access-Control-Allow-Origin': false
						},
						integrationResponseParams = {
							'method.response.header.Access-Control-Allow-Origin': '\'*\''
						},
						responseTemplates = {},
						responseModels = {},
						contentType = response.contentType || 'application/json';

					if (isRedirect(response.code)) {
						methodResponseParams['method.response.header.Location'] = false;
						integrationResponseParams['method.response.header.Location'] = 'integration.response.body';
						responseTemplates[contentType] = '##';
					} else {
						if (response.contentType) {
							methodResponseParams['method.response.header.Content-Type'] = false;
							integrationResponseParams['method.response.header.Content-Type'] = '\'' + response.contentType + '\'';
						}
						responseTemplates[contentType] = response.template || '';
					}
					responseModels[contentType] = 'Empty';
					return apiGateway.putMethodResponseAsync({
						restApiId: restApiId,
						resourceId: resourceId,
						httpMethod: methodName,
						statusCode: response.code,
						responseParameters: methodResponseParams,
						responseModels: responseModels
					}).then(function () {
						return apiGateway.putIntegrationResponseAsync({
							restApiId: restApiId,
							resourceId: resourceId,
							httpMethod: methodName,
							statusCode: response.code,
							selectionPattern: response.pattern,
							responseParameters: integrationResponseParams,
							responseTemplates: responseTemplates
						});
					});
				};
			return apiGateway.putMethodAsync({
				authorizationType: 'NONE', /*todo support config */
				httpMethod: methodName,
				resourceId: resourceId,
				restApiId: restApiId
			}).then(function () {
				return apiGateway.putIntegrationAsync({
					restApiId: restApiId,
					resourceId: resourceId,
					httpMethod: methodName,
					type: 'AWS',
					integrationHttpMethod: 'POST',
					requestTemplates: {
						'application/json': inputTemplateJson,
						'application/x-www-form-urlencoded': inputTemplateForm
					},
					uri: 'arn:aws:apigateway:' + awsRegion + ':lambda:path/2015-03-31/functions/arn:aws:lambda:' + awsRegion + ':' + ownerId + ':function:' + functionName + ':${stageVariables.lambdaVersion}/invocations'
				});
			}).then(function () {
				var results = [{code: successCode(), pattern: '', contentType: successContentType(), template: successTemplate()}];
				if (errorCode() !== successCode()) {
					results[0].pattern = '^$';
					results.push({code: errorCode(), pattern: '', contentType: errorContentType(), template: errorTemplate()});
				}
				return Promise.map(results, addCodeMapper, {concurrency: 1});
			});
		},
		createCorsHandler = function (resourceId, allowedMethods) {
			return apiGateway.putMethodAsync({
				authorizationType: 'NONE', /*todo support config */
				httpMethod: 'OPTIONS',
				resourceId: resourceId,
				restApiId: restApiId
			}).then(function () {
				return apiGateway.putIntegrationAsync({
					restApiId: restApiId,
					resourceId: resourceId,
					httpMethod: 'OPTIONS',
					type: 'MOCK',
					requestTemplates: {
						'application/json': '{\"statusCode\": 200}'
					}
				});
			}).then(function () {
				return apiGateway.putMethodResponseAsync({
					restApiId: restApiId,
					resourceId: resourceId,
					httpMethod: 'OPTIONS',
					statusCode: '200',
					responseModels: {
						'application/json': 'Empty'
					},
					responseParameters: {
						'method.response.header.Access-Control-Allow-Headers': false,
						'method.response.header.Access-Control-Allow-Methods': false,
						'method.response.header.Access-Control-Allow-Origin': false
					}
				});
			}).then(function () {
				return apiGateway.putIntegrationResponseAsync({
					restApiId: restApiId,
					resourceId: resourceId,
					httpMethod: 'OPTIONS',
					statusCode: '200',
					responseTemplates: {
						'application/json': ''
					},
					responseParameters: {
						'method.response.header.Access-Control-Allow-Headers': '\'Content-Type,X-Amz-Date,Authorization,X-Api-Key\'',
						'method.response.header.Access-Control-Allow-Methods': '\'' + allowedMethods.join(',') + ',OPTIONS\'',
						'method.response.header.Access-Control-Allow-Origin': '\'*\''
					}
				});
			});
		},
		configurePath = function (path) {
			var resourceId, findResource,
				supportedMethods = Object.keys(apiConfig.routes[path]),
				createMethodMapper = function (methodName) {
					return createMethod(methodName, resourceId, apiConfig.routes[path][methodName]);
				};
			if (path === '') {
				resourceId = rootResourceId;
				findResource = Promise.resolve();
			} else {
				findResource = apiGateway.createResourceAsync({
					restApiId: restApiId,
					parentId: rootResourceId,
					pathPart: path
				}).then(function (resource) {
					resourceId = resource.id;
				});
			}
			return findResource.then(function () {
				return Promise.map(supportedMethods, createMethodMapper, {concurrency: 1});
			}).then(function () {
				return createCorsHandler(resourceId, supportedMethods);
			});
		},
		dropMethods = function (resource) {
			var dropMethodMapper = function (method) {
				return apiGateway.deleteMethodAsync({
					resourceId: resource.id,
					restApiId: restApiId,
					httpMethod: method
				});
			};
			if (resource.resourceMethods) {
				return Promise.map(Object.keys(resource.resourceMethods), dropMethodMapper, {concurrency: 1});
			}
		},
		dropSubresources = function () {
			var removeResourceMapper = function (resource) {
				if (resource.id !== rootResourceId) {
					return apiGateway.deleteResourceAsync({
						resourceId: resource.id,
						restApiId: restApiId
					});
				} else {
					return dropMethods(resource);
				}
			};
			return Promise.map(existingResources, removeResourceMapper, {concurrency: 1});
		},
		readTemplates = function () {
			return fs.readFileAsync(templateFile('apigw-params-json.txt'), 'utf8')
			.then(function (inputTemplate) {
				inputTemplateJson = inputTemplate;
			}).then(function () {
				return fs.readFileAsync(templateFile('apigw-params-form.txt'), 'utf8');
			}).then(function (inputTemplate) {
				inputTemplateForm = inputTemplate;
			});
		},
		rebuildApi = function () {
			return allowApiInvocation(functionName, functionVersion, restApiId, ownerId, awsRegion)
			.then(getExistingResources)
			.then(function (resources) {
				existingResources = resources.items;
				return existingResources;
			}).then(findRoot)
			.then(dropSubresources)
			.then(function () {
				return Promise.map(Object.keys(apiConfig.routes), configurePath, {concurrency: 1});
			});
		},
		deployApi = function () {
			return apiGateway.createDeploymentAsync({
				restApiId: restApiId,
				stageName: functionVersion,
				variables: {
					lambdaVersion: functionVersion
				}
			});
		},
		upgradeConfig = function (config) {
			var result;
			if (config.version === 2) {
				return config;
			}
			result = { version: 2, routes: {} };
			Object.keys(config).forEach(function (route) {
				result.routes[route] = {};
				config[route].methods.forEach(function (methodName) {
					result.routes[route][methodName] = {};
				});
			});
			return result;
		};
	apiConfig = upgradeConfig(requestedConfig);
	return getOwnerId()
		.then(readTemplates)
		.then(rebuildApi)
		.then(deployApi);
};


