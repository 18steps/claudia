# Release history

### 1.0.15  11 March 2016

- support for apiKeyRequired option in the apiBuilder methods. See [Requiring Api Keys](https://github.com/claudiajs/claudia-api-builder#requiring-api-keys) for more information

### 1.0.14 9 March 2016

- better error message when the `api-module` argument is not compatible with the `ApiBuilder` interface (eg people forget to export the api);

### 1.0.13 8 March 2016

- support for text/xml requests

### 1.0.12

- scheduled events now support `--cron` shorthand argument for easier parsing on Windows

### 1.0.11

- scheduled events now support `--rate` shorthand argument for easier parsing on Windows

### 1.0.10 4 March 2016

- Support for alternative config files (instead of claudia.json). just supply `--config FILE_NAME` to any command

### 1.0.9 29 February 2016

- bugfix for empty FORM post parameters
