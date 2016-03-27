/*global module, require */
var aws = require('aws-sdk'),
	Promise = require('bluebird'),
	templateFile = require('../util/template-file'),
	validHttpCode = require('../util/valid-http-code'),
	allowApiInvocation = require('./allow-api-invocation'),
	pathSplitter = require('../util/path-splitter'),
	retriableWrap = require('../util/wrap'),
	fs = Promise.promisifyAll(require('fs'));
module.exports = function rebuildWebApi(functionName, functionVersion, restApiId, requestedConfig, awsRegion, verbose) {
	'use strict';
	var iam = Promise.promisifyAll(new aws.IAM()),
		apiGateway = retriableWrap('apiGateway', Promise.promisifyAll(new aws.APIGateway({region: awsRegion})), verbose),
		apiConfig,
		existingResources,
		ownerId,
		knownIds = {},
		inputTemplate,
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
			knownIds[''] = rootResource.id;
			return rootResource.id;
		},
		supportsCors = function () {
			return (apiConfig.corsHandlers !== false);
		},
		putMockIntegration = function (resourceId, httpMethod) {
			return apiGateway.putIntegrationAsync({
				restApiId: restApiId,
				resourceId: resourceId,
				httpMethod: httpMethod,
				type: 'MOCK',
				requestTemplates: {
					'application/json': '{\"statusCode\": 200}'
				}
			});
		},
		putLambdaIntegration = function (resourceId, methodName) {
			return apiGateway.putIntegrationAsync({
				restApiId: restApiId,
				resourceId: resourceId,
				httpMethod: methodName,
				type: 'AWS',
				integrationHttpMethod: 'POST',
				requestTemplates: {
					'application/json': inputTemplate,
					'application/x-www-form-urlencoded': inputTemplate,
					'text/xml': inputTemplate
				},
				uri: 'arn:aws:apigateway:' + awsRegion + ':lambda:path/2015-03-31/functions/arn:aws:lambda:' + awsRegion + ':' + ownerId + ':function:' + functionName + ':${stageVariables.lambdaVersion}/invocations'
			});
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
				apiKeyRequired = function () {
					return methodOptions && methodOptions.apiKeyRequired;
				},
				isRedirect = function (code) {
					return /3[0-9][0-9]/.test(code);
				},
				errorContentType = function () {
					return methodOptions && methodOptions.error && methodOptions.error.contentType;
				},
				headers = function (responseType) {
					var headers = methodOptions && methodOptions[responseType] && methodOptions[responseType].headers;
					if (headers && !Array.isArray(headers)) {
						headers = Object.keys(headers);
					}
					return headers;
				},
				successContentType = function () {
					return methodOptions && methodOptions.success && methodOptions.success.contentType;
				},
				successTemplateV2 = function () {
					var contentType = successContentType();
					if (!contentType || contentType === 'application/json') {
						return '';
					}
					return '$input.path(\'$\')';
				},
				successTemplate = function () {
					// success codes can also be used as error codes, so this has to work for both
					var contentType = successContentType(), extractor = 'path';
					if (requestedConfig.version === 2) {
						return successTemplateV2();
					}
					if (!contentType || contentType === 'application/json') {
						extractor = 'json';
					}
					return '#if($input.path(\'$.errorMessage\')!="")' +
							'$input.' + extractor + '(\'$\')' +
							'#{else}' +
							'$input.' + extractor + '(\'$.response\')' +
							'#{end}';
				},
				errorTemplate = function () {
					var contentType = errorContentType();
					if (!contentType || contentType === 'application/json') {
						return '';
					}
					return '$input.path(\'$.errorMessage\')';
				},
				addCodeMapper = function (response) {
					var methodResponseParams = { },
						integrationResponseParams = { },
						responseTemplates = {},
						responseModels = {},
						contentType = response.contentType || 'application/json';
					if (supportsCors()) {
						methodResponseParams = {
							'method.response.header.Access-Control-Allow-Origin': false,
							'method.response.header.Access-Control-Allow-Headers': false
						};
						if (apiConfig.corsHandlers) {
							integrationResponseParams = {
								'method.response.header.Access-Control-Allow-Headers': 'integration.response.body.headers.Access-Control-Allow-Headers',
								'method.response.header.Access-Control-Allow-Origin': 'integration.response.body.headers.Access-Control-Allow-Origin'
							};
						} else {
							integrationResponseParams = {
								'method.response.header.Access-Control-Allow-Origin': '\'*\'',
								'method.response.header.Access-Control-Allow-Headers': '\'Content-Type,X-Amz-Date,Authorization,X-Api-Key\''
							};
						}
					}
					if (isRedirect(response.code)) {
						methodResponseParams['method.response.header.Location'] = false;
						if (requestedConfig.version < 3) {
							integrationResponseParams['method.response.header.Location'] = 'integration.response.body';
						} else {
							integrationResponseParams['method.response.header.Location'] = 'integration.response.body.response';
						}
						responseTemplates[contentType] = '##';
					} else {
						if (response.contentType) {
							methodResponseParams['method.response.header.Content-Type'] = false;
							integrationResponseParams['method.response.header.Content-Type'] = '\'' + response.contentType + '\'';
						}
						responseTemplates[contentType] = response.template || '';
					}
					if (response.headers) {
						response.headers.forEach(function (headerName) {
							methodResponseParams['method.response.header.' + headerName] = false;
							integrationResponseParams['method.response.header.' + headerName] = 'integration.response.body.headers.' + headerName;
						});
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
				restApiId: restApiId,
				apiKeyRequired: apiKeyRequired()
			}).then(function () {
				return putLambdaIntegration(resourceId, methodName);
			}).then(function () {
				var results = [{code: successCode(), pattern: '', contentType: successContentType(), template: successTemplate(), headers: headers('success')}];
				if (errorCode() !== successCode()) {
					results[0].pattern = '^$';
					results.push({code: errorCode(), pattern: '', contentType: errorContentType(), template: errorTemplate(), headers: headers('error')});
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
				if (apiConfig.corsHandlers) {
					return putLambdaIntegration(resourceId, 'OPTIONS');
				} else {
					return putMockIntegration(resourceId, 'OPTIONS');
				}
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
				var responseParams = {
						'method.response.header.Access-Control-Allow-Headers': '\'Content-Type,X-Amz-Date,Authorization,X-Api-Key\'',
						'method.response.header.Access-Control-Allow-Methods': '\'' + allowedMethods.join(',') + ',OPTIONS\'',
						'method.response.header.Access-Control-Allow-Origin': '\'*\''
					};
				if (apiConfig.corsHandlers) {
					responseParams['method.response.header.Access-Control-Allow-Headers'] = 'integration.response.body.headers.Access-Control-Allow-Headers';
					responseParams['method.response.header.Access-Control-Allow-Origin'] = 'integration.response.body.headers.Access-Control-Allow-Origin';
				}
				return apiGateway.putIntegrationResponseAsync({
					restApiId: restApiId,
					resourceId: resourceId,
					httpMethod: 'OPTIONS',
					statusCode: '200',
					responseTemplates: {
						'application/json': ''
					},
					responseParameters: responseParams
				});
			});
		},
		findResourceByPath = function (path) {
			var pathComponents = pathSplitter(path);
			if (knownIds[path]) {
				return Promise.resolve(knownIds[path]);
			} else {
				return findResourceByPath(pathComponents.parentPath)
				.then(function (parentId) {
					return apiGateway.createResourceAsync({
						restApiId: restApiId,
						parentId: parentId,
						pathPart: pathComponents.pathPart
					});
				}).then(function (resource) {
					knownIds[path] = resource.id;
					return resource.id;
				});
			}
		},
		configurePath = function (path) {
			var resourceId,
				supportedMethods = Object.keys(apiConfig.routes[path]),
				createMethodMapper = function (methodName) {
					return createMethod(methodName, resourceId, apiConfig.routes[path][methodName]);
				};
			return findResourceByPath(path).then(function (r) {
				resourceId = r;
			}).then(function () {
				return Promise.map(supportedMethods, createMethodMapper, {concurrency: 1});
			}).then(function () {
				if (supportsCors()) {
					return createCorsHandler(resourceId, supportedMethods);
				}
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
			} else {
				return Promise.resolve();
			}
		},
		removeResource = function (resource) {
			if (resource.path !== '/') {
				return apiGateway.deleteResourceAsync({
					resourceId: resource.id,
					restApiId: restApiId
				});
			} else {
				return dropMethods(resource);
			}
		},
		dropSubresources = function () {
			var currentResource;
			if (existingResources.length === 0) {
				return Promise.resolve();
			} else {
				currentResource = existingResources.pop();
				return removeResource(currentResource).then(function () {
					if (existingResources.length > 0) {
						return dropSubresources();
					}
				});
			}
		},
		readTemplates = function () {
			return fs.readFileAsync(templateFile('apigw-params.txt'), 'utf8')
			.then(function (fileContents) {
				inputTemplate = fileContents;
			});
		},
		pathSort = function (resA, resB) {
			if (resA.path > resB.path) {
				return 1;
			} else if (resA.path === resB.path) {
				return 0;
			}
			return -1;
		},
		rebuildApi = function () {
			return allowApiInvocation(functionName, functionVersion, restApiId, ownerId, awsRegion)
			.then(getExistingResources)
			.then(function (resources) {
				existingResources = resources.items;
				existingResources.sort(pathSort);
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
			if (config.version >= 2) {
				return config;
			}
			result = { version: 3, routes: {} };
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
