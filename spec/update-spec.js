/*global describe, require, it, expect, beforeEach, afterEach, console, jasmine */
var underTest = require('../src/commands/update'),
	create = require('../src/commands/create'),
	shell = require('shelljs'),
	tmppath = require('../src/util/tmppath'),
	callApi = require('../src/util/call-api'),
	Promise = require('bluebird'),
	fs = Promise.promisifyAll(require('fs')),
	path = require('path'),
	aws = require('aws-sdk'),
	awsRegion = 'us-east-1';
describe('update', function () {
	'use strict';
	var workingdir, testRunName,  lambda, newObjects,
		invoke = function (url, options) {
			if (!options) {
				options = {};
			}
			options.retry = 403;
			return callApi(newObjects.restApi, awsRegion, url, options);
		};
	beforeEach(function () {
		workingdir = tmppath();
		testRunName = 'test' + Date.now();
		lambda = Promise.promisifyAll(new aws.Lambda({region: awsRegion}), {suffix: 'Promise'});
		jasmine.DEFAULT_TIMEOUT_INTERVAL = 40000;
		newObjects = {workingdir: workingdir};
		shell.mkdir(workingdir);
	});
	afterEach(function (done) {
		this.destroyObjects(newObjects).catch(function (err) {
			console.log('error cleaning up', err);
		}).finally(done);
	});
	it('fails when the source dir does not contain the project config file', function (done) {
		underTest({source: workingdir}).then(done.fail, function (reason) {
			expect(reason).toEqual('claudia.json does not exist in the source folder');
			done();
		});
	});

	it('fails when the project config file does not contain the lambda name', function (done) {
		fs.writeFileSync(path.join(workingdir, 'claudia.json'), '{}', 'utf8');
		underTest({source: workingdir}).then(done.fail, function (reason) {
			expect(reason).toEqual('invalid configuration -- lambda.name missing from claudia.json');
			done();
		});
	});
	it('fails when the project config file does not contain the lambda region', function (done) {
		fs.writeFileSync(path.join(workingdir, 'claudia.json'), JSON.stringify({lambda: {name: 'xxx'}}), 'utf8');
		underTest({source: workingdir}).then(done.fail, function (reason) {
			expect(reason).toEqual('invalid configuration -- lambda.region missing from claudia.json');
			done();
		});
	});
	describe('when the config exists', function () {
		beforeEach(function (done) {
			shell.cp('-r', 'spec/test-projects/hello-world/*', workingdir);
			create({name: testRunName, region: awsRegion, source: workingdir, handler: 'main.handler'}).then(function (result) {
				newObjects.lambdaRole = result.lambda && result.lambda.role;
				newObjects.lambdaFunction = result.lambda && result.lambda.name;
				shell.cp('-rf', 'spec/test-projects/echo/*', workingdir);
			}).then(done, done.fail);
		});
		it('fails if the lambda no longer exists', function (done) {
			fs.readFileAsync(path.join(workingdir, 'claudia.json'), 'utf8')
			.then(JSON.parse)
			.then(function (contents) {
				contents.lambda.name = contents.lambda.name + '-xxx';
				return contents;
			}).then(JSON.stringify)
			.then(function (contents) {
				return fs.writeFileAsync(path.join(workingdir, 'claudia.json'), contents, 'utf8');
			}).then(function () {
				return underTest({source: workingdir});
			}).then(done.fail, function (reason) {
				expect(reason.code).toEqual('ResourceNotFoundException');
			}).then(done);
		});
		it('validates the package before updating the lambda', function (done) {
			shell.cp('-rf', 'spec/test-projects/echo-dependency-problem/*', workingdir);
			underTest({source: workingdir})
			.then(done.fail, function (reason) {
				expect(reason).toEqual('cannot require ./main after npm install --production. Check your dependencies.');
			}).then(function () {
				return lambda.listVersionsByFunctionPromise({FunctionName: testRunName});
			}).then(function (result) {
				expect(result.Versions.length).toEqual(2);
			}).then(done, done.fail);
		});
		it('creates a new version of the lambda function', function (done) {
			underTest({source: workingdir}).then(function (lambdaFunc) {
				expect(new RegExp('^arn:aws:lambda:us-east-1:[0-9]+:function:' + testRunName + ':2$').test(lambdaFunc.FunctionArn)).toBeTruthy();
			}).then(function () {
				return lambda.listVersionsByFunctionPromise({FunctionName: testRunName});
			}).then(function (result) {
				expect(result.Versions.length).toEqual(3);
				expect(result.Versions[0].Version).toEqual('$LATEST');
				expect(result.Versions[1].Version).toEqual('1');
				expect(result.Versions[2].Version).toEqual('2');
			}).then(done, done.fail);
		});
		it('updates the lambda with a new version', function (done) {
			underTest({source: workingdir}).then(function () {
				return lambda.invokePromise({FunctionName: testRunName, Payload: JSON.stringify({message: 'aloha'})});
			}).then(function (lambdaResult) {
				expect(lambdaResult.StatusCode).toEqual(200);
				expect(lambdaResult.Payload).toEqual('{"message":"aloha"}');
			}).then(done, done.fail);
		});
		it('adds the version alias if supplied', function (done) {
			underTest({source: workingdir, version: 'great'}).then(function () {
				return lambda.getAliasPromise({FunctionName: testRunName, Name: 'great'});
			}).then(function (result) {
				expect(result.FunctionVersion).toEqual('2');
			}).then(done, done.fail);
		});

		it('checks the current dir if the source is not provided', function (done) {
			shell.cd(workingdir);
			underTest().then(function (lambdaFunc) {
				expect(new RegExp('^arn:aws:lambda:us-east-1:[0-9]+:function:' + testRunName + ':2$').test(lambdaFunc.FunctionArn)).toBeTruthy();
				expect(lambdaFunc.FunctionName).toEqual(testRunName);
				return lambda.invokePromise({FunctionName: testRunName, Payload: JSON.stringify({message: 'aloha'})});
			}).then(done, done.fail);
		});
	});
	describe('when the lambda project contains a web api', function () {
		var originaldir, updateddir;
		beforeEach(function (done) {
			originaldir =  path.join(workingdir, 'original');
			updateddir = path.join(workingdir, 'updated');
			shell.mkdir(originaldir);
			shell.mkdir(updateddir);
			shell.cp('-r', 'spec/test-projects/api-gw-hello-world/*', originaldir);
			shell.cp('-r', 'spec/test-projects/api-gw-echo/*', updateddir);
			create({name: testRunName, version: 'original', region: awsRegion, source: originaldir, 'api-module': 'main'}).then(function (result) {
				newObjects.lambdaRole = result.lambda && result.lambda.role;
				newObjects.lambdaFunction = result.lambda && result.lambda.name;
				newObjects.restApi = result.api && result.api.id;
				shell.cp(path.join(originaldir, 'claudia.json'), updateddir);
			}).then(done, done.fail);
		});
		it('fails if the api no longer exists', function (done) {
			fs.readFileAsync(path.join(updateddir, 'claudia.json'), 'utf8')
			.then(JSON.parse)
			.then(function (contents) {
				contents.api.id = contents.api.id + '-xxx';
				return contents;
			}).then(JSON.stringify)
			.then(function (contents) {
				return fs.writeFileAsync(path.join(updateddir, 'claudia.json'), contents, 'utf8');
			}).then(function () {
				return underTest({source: updateddir});
			}).then(done.fail, function (reason) {
				expect(reason.code).toEqual('NotFoundException');
			}).then(function () {
				return lambda.listVersionsByFunctionPromise({FunctionName: testRunName});
			}).then(function (result) {
				expect(result.Versions.length).toEqual(2);
				expect(result.Versions[0].Version).toEqual('$LATEST');
				expect(result.Versions[1].Version).toEqual('1');
			}).then(done, done.fail);
		});
		it('validates the package before creating a new lambda version', function (done) {
			shell.cp('-rf', 'spec/test-projects/echo-dependency-problem/*', updateddir);
			underTest({source: updateddir}).then(done.fail, function (reason) {
				expect(reason).toEqual('cannot require ./main after npm install --production. Check your dependencies.');
			}).then(function () {
				return lambda.listVersionsByFunctionPromise({FunctionName: testRunName});
			}).then(function (result) {
				expect(result.Versions.length).toEqual(2);
				expect(result.Versions[0].Version).toEqual('$LATEST');
				expect(result.Versions[1].Version).toEqual('1');
			}).then(done, done.fail);
		});


		it('updates the api using the configuration from the api module', function (done) {
			return underTest({source: updateddir}).then(function (result) {
				expect(result.url).toEqual('https://' + newObjects.restApi + '.execute-api.' + awsRegion + '.amazonaws.com/latest');
			}).then(function () {
				return invoke('latest/echo?name=mike');
			}).then(function (contents) {
				var params = JSON.parse(contents.body);
				expect(params.queryString).toEqual({name: 'mike'});
				expect(params.context.method).toEqual('GET');
				expect(params.context.path).toEqual('/echo');
				expect(params.env).toEqual({
					lambdaVersion: 'latest'
				});
			}).then(done, done.fail);
		});
		it('when the version is provided, creates the deployment with that name', function (done) {
			underTest({source: updateddir, version: 'development'}).then(function (result) {
				expect(result.url).toEqual('https://' + newObjects.restApi + '.execute-api.' + awsRegion + '.amazonaws.com/development');
			}).then(function () {
				return invoke('development/echo?name=mike');
			}).then(function (contents) {
				var params = JSON.parse(contents.body);
				expect(params.queryString).toEqual({name: 'mike'});
				expect(params.context.method).toEqual('GET');
				expect(params.context.path).toEqual('/echo');
				expect(params.env).toEqual({
					lambdaVersion: 'development'
				});
			}).then(done, done.fail);
		});
		it('if using a different version, leaves the old one intact', function (done) {
			underTest({source: updateddir, version: 'development'}).then(function () {
				return invoke('original/hello');
			}).then(function (contents) {
				expect(contents.body).toEqual('"hello world"');
			}).then(done, done.fail);
		});
		it('if using the same version, rewrites the old one', function (done) {
			underTest({source: updateddir, version: 'original'}).then(function () {
				return invoke('original/echo?name=mike');
			}).then(function (contents) {
				var params = JSON.parse(contents.body);
				expect(params.queryString).toEqual({name: 'mike'});
				expect(params.context.method).toEqual('GET');
				expect(params.context.path).toEqual('/echo');
				expect(params.env).toEqual({
					lambdaVersion: 'original'
				});
			}).then(done, done.fail);
		});
	});
});
