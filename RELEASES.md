# Release history

### 1.1.0

- all validations are executed before any objects are created/updated, to avoid partially created functions
- web API handlers can now set custom headers (requires API Builder )
- web API handlers can now set custom CORS origins, or completely disable CORS (requires API Builder )
- web API now accepts text/plain content for POST, PUT and PATCH
- create and update prevent several common user errors and report more meaningfully on those
  - when the lambda handler can't be required (eg package dependency issue or syntax error)
  - when the API module does not export a Claudia API Builder-compatible interface (eg forgot to do module.exports)
  - when the API module does not contain any configured methods
  - when the API module does not contain the configured handler method
  - when the custom policies argument is specified but no files match it
  - when updating over a non-existent (eg removed) function or API definition
  - when working with an incompatible API version (eg claudia needs to be updated)

### 1.0.19, 25 March 2016

- retry TooManyRequestsException automatically, AWS SDK seems to have a recurring bug to not retry those 

### 1.0.18, 22 March 2016

- use --version to print current version
- test-lambda now accepts --version
- documentation re-structured so individual commands now print out options with --help
- markdown docs for the API on github

### 1.0.17, 21 March 2016

- bugfix to handle correctly POST operations with a charset (jQuery Ajax does this)

### 1.0.16, 16 March 2016

- utility destroy command for undeploying lambda and removing the API and associated roles. 

### 1.0.15, 11 March 2016

- support for apiKeyRequired option in the apiBuilder methods. See [Requiring Api Keys](https://github.com/claudiajs/claudia-api-builder#requiring-api-keys) for more information

### 1.0.14, 9 March 2016

- better error message when the `api-module` argument is not compatible with the `ApiBuilder` interface (eg people forget to export the api);

### 1.0.13, 8 March 2016

- support for text/xml requests

### 1.0.12

- scheduled events now support `--cron` shorthand argument for easier parsing on Windows

### 1.0.11

- scheduled events now support `--rate` shorthand argument for easier parsing on Windows

### 1.0.10, 4 March 2016

- Support for alternative config files (instead of claudia.json). just supply `--config FILE_NAME` to any command

### 1.0.9, 29 February 2016

- bugfix for empty FORM post parameters
