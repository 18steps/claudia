/*global describe, it, beforeEach, afterEach, require, it, expect */
var underTest = require('../src/tasks/collect-files'),
	shell = require('shelljs'),
	os = require('os'),
	fs = require('fs'),
	tmppath = require('../src/util/tmppath'),
	path = require('path');
describe('collectFiles', function () {
	'use strict';
	var destdir, sourcedir, pwd,
		configurePackage = function (packageConf) {
			fs.writeFileSync(path.join(sourcedir, 'package.json'), JSON.stringify(packageConf), 'utf8');
		};
	beforeEach(function () {
		sourcedir = tmppath();
		shell.mkdir(sourcedir);
		fs.writeFileSync(path.join(sourcedir, 'root.txt'), 'text1', 'utf8');
		fs.writeFileSync(path.join(sourcedir, 'excluded.txt'), 'excl1', 'utf8');
		shell.mkdir(path.join(sourcedir, 'subdir'));
		fs.writeFileSync(path.join(sourcedir, 'subdir', 'sub.txt'), 'text2', 'utf8');
		pwd = shell.pwd();
	});
	afterEach(function () {
		shell.cd(pwd);
		if (destdir) {
			shell.rm('-rf', destdir);
		}
		if (sourcedir) {
			shell.rm('-rf', sourcedir);
		}
	});
	it('fails if the source directory is not provided', function (done) {
		underTest().then(done.fail, function (message) {
			expect(message).toEqual('source directory not provided');
			done();
		});
	});
	it('fails if the source directory does not exist', function (done) {
		underTest(tmppath()).then(done.fail, function (message) {
			expect(message).toEqual('source directory does not exist');
			done();
		});
	});
	it('fails if the source directory is not a directory', function (done) {
		var filePath = path.join(sourcedir, 'file.txt');
		fs.writeFileSync(filePath, '{}', 'utf8');
		underTest(filePath).then(done.fail, function (message) {
			expect(message).toEqual('source path must be a directory');
			done();
		});
	});
	it('fails if package.json does not exist in the source directory', function (done) {
		underTest(sourcedir).then(done.fail, function (message) {
			expect(message).toEqual('source directory does not contain package.json');
			done();
		});
	});
	it('fails if package.json does not contain the files property', function (done) {
		configurePackage({});
		underTest(sourcedir).then(done.fail, function (message) {
			expect(message).toEqual('package.json does not contain the files property');
			done();
		});
	});
	it('copies all the listed files/subfolders/with wildcards from the files property to a folder in temp path', function (done) {
		configurePackage({files: ['roo*', 'subdir']});
		underTest(sourcedir).then(function (packagePath) {
			destdir = packagePath;
			expect(path.dirname(packagePath)).toEqual(os.tmpdir());
			expect(fs.readFileSync(path.join(packagePath, 'root.txt'), 'utf8')).toEqual('text1');
			expect(fs.readFileSync(path.join(packagePath, 'subdir', 'sub.txt'), 'utf8')).toEqual('text2');
			done();
		}, done.fail);
	});
	it('includes package.json even if it is not in the files property', function (done) {
		configurePackage({files: ['roo*']});
		underTest(sourcedir).then(function (packagePath) {
			destdir = packagePath;
			expect(shell.test('-e', path.join(packagePath, 'package.json'))).toBeTruthy();
			done();
		}, done.fail);
	});
	it('does not include any other files', function (done) {
		configurePackage({files: ['roo*']});
		underTest(sourcedir).then(function (packagePath) {
			destdir = packagePath;
			expect(shell.test('-e', path.join(packagePath, 'excluded.txt'))).toBeFalsy();
			expect(shell.test('-e', path.join(packagePath, 'subdir'))).toBeFalsy();
			done();
		}, done.fail);
	});
	it('collects production npm dependencies if package config includes the dependencies flag', function (done) {
		configurePackage({
			files: ['root.txt'],
			dependencies: {
				'uuid': '^2.0.0'
			},
			devDependencies: {
				'minimist': '^1.2.0'
			}
		});
		underTest(sourcedir).then(function (packagePath) {
			destdir = packagePath;
			expect(shell.test('-e', path.join(packagePath, 'node_modules', 'uuid'))).toBeTruthy();
			expect(shell.test('-e', path.join(packagePath, 'node_modules', 'minimist'))).toBeFalsy();
			done();
		}, done.fail);

	});
	it('fails if npm install fails', function (done) {
		configurePackage({
			files: ['root.txt'],
			dependencies: {
				'non-existing-package': '2.0.0'
			}
		});
		underTest(sourcedir).then(done.fail, function (reason) {
			expect(/^npm install --production failed/.test(reason)).toBeTruthy();
			done();
		});
	});
	it('does not change the current working dir', function (done) {
		configurePackage({files: ['roo*', 'subdir']});
		underTest(sourcedir).then(function () {
			expect(shell.pwd()).toEqual(pwd);
			done();
		}, done.fail);
	});
	it('does not change the current working dir even if npm install fails', function (done) {
		configurePackage({
			files: ['root.txt'],
			dependencies: {
				'non-existing-package': '2.0.0'
			}
		});
		underTest(sourcedir).then(done.fail, function () {
			expect(shell.pwd()).toEqual(pwd);
			done();
		});

	});

});
