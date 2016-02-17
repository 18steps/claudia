/*global module, require */
var aws = require('aws-sdk'),
	Promise = require('bluebird'),
	templateFile = require('../util/template-file'),
	fs = Promise.promisifyAll(require('fs'));
module.exports = function rebuildWebApi(functionName, functionVersion, restApiId, apiConfig, awsRegion) {
	'use strict';
	var iam = Promise.promisifyAll(new aws.IAM()),
		lambda = Promise.promisifyAll(new aws.Lambda({region: awsRegion}), {suffix: 'Promise'}),
		apiGateway = Promise.promisifyAll(new aws.APIGateway({region: awsRegion})),
		existingResources,
		rootResourceId,
		ownerId,
		paramsInputTemplate,
		getOwnerId = function () {
			return iam.getUserAsync().then(function (result) {
				ownerId = result.User.UserId;
			});
		},
		find = function (array, predicate, context) { /* no .find support in 10.0 */
			var result;
			array.forEach(function (element) {
				if (!result && predicate(element, context)) {
					result = element;
				}
			});
			return result;
		},
		allowApiInvocation = function () {
			var policy = {
					Action: 'lambda:InvokeFunction',
					FunctionName: functionName,
					Principal: 'apigateway.amazonaws.com',
					SourceArn: 'arn:aws:execute-api:' + awsRegion + ':' + ownerId + ':' + restApiId + '/*/*/*',
					Qualifier: functionVersion,
					StatementId: 'web-api-access-' + functionVersion + '-' + Date.now()
				},
				matchesPolicy = function (statement) {
					return statement.Action === policy.Action &&
						statement.Principal && statement.Principal.Service ===  policy.Principal &&
						statement.Condition && statement.Condition.ArnLike &&
						statement.Condition.ArnLike['AWS:SourceArn'] === policy.SourceArn &&
						statement.Effect === 'Allow';
				};
			return lambda.getPolicyPromise({
				FunctionName: functionName,
				Qualifier: functionVersion
			}).then(function (policyResponse) {
				return policyResponse && policyResponse.Policy && JSON.parse(policyResponse.Policy);
			}).then(function (currentPolicy) {
				var statements = (currentPolicy && currentPolicy.Statement) || [];
				if (!find(statements, matchesPolicy)) {
					return lambda.addPermissionPromise(policy);
				}
			}, function (e) {
				if (e && e.code === 'ResourceNotFoundException') {
					return lambda.addPermissionPromise(policy);
				} else {
					return Promise.reject(e);
				}
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
			rootResourceId = findByPath(existingResources, '/').id;
			return rootResourceId;
		},
		createMethod = function (methodName, resourceId) {
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
						'application/json': paramsInputTemplate
					},
					uri: 'arn:aws:apigateway:' + awsRegion + ':lambda:path/2015-03-31/functions/arn:aws:lambda:' + awsRegion + ':' + ownerId + ':function:' + functionName + ':${stageVariables.lambdaVersion}/invocations'
				});
			}).then(function () {
				return apiGateway.putMethodResponseAsync({
					restApiId: restApiId,
					resourceId: resourceId,
					httpMethod: methodName,
					statusCode: '200',
					responseModels: {
						'application/json': 'Empty'
					}
				});
			}).then(function () {
				return apiGateway.putIntegrationResponseAsync({
					restApiId: restApiId,
					resourceId: resourceId,
					httpMethod: methodName,
					statusCode: '200',
					responseTemplates: {
						'application/json': ''
					}
				});
			});
		},
		createPath = function (path) {
			return apiGateway.createResourceAsync({
				restApiId: restApiId,
				parentId: rootResourceId,
				pathPart: path
			}).then(function (resource) {
				var createMethodMapper = function (methodName) {
					return createMethod(methodName, resource.id);
				};
				return Promise.map(apiConfig[path].methods, createMethodMapper, {concurrency: 1});
			});
		},
		dropSubresources = function () {
			var removeResourceMapper = function (resource) {
				if (resource.id !== rootResourceId) {
					return apiGateway.deleteResourceAsync({
						resourceId: resource.id,
						restApiId: restApiId
					});
				}
			};
			return Promise.map(existingResources, removeResourceMapper, {concurrency: 1});
		},
		rebuildApi = function () {
			return allowApiInvocation()
			.then(getExistingResources)
			.then(function (resources) {
				existingResources = resources.items;
				return existingResources;
			})
			.then(findRoot)
			.then(dropSubresources)
			.then(function () {
				return Promise.map(Object.keys(apiConfig), createPath, {concurrency: 1});
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
		};
	return getOwnerId().then(function () {
		return fs.readFileAsync(templateFile('apigw-params-input.txt'), 'utf8');
	}).then(function (inputTemplate) {
		paramsInputTemplate = inputTemplate;
	}).then(rebuildApi).then(deployApi);
};


