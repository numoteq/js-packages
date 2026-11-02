# @numoteq/emdash-plugin-ahasend

## 1.0.1

### Patch Changes

- 1deb99e: Update the bundled AhaSend SDK from 0.3.0 to 0.4.0. The SDK release is additive for the calls this plugin makes (`messages.send` and `messages.sendConversation`), and the breaking type changes it ships (`TemplateVariable.kind`, `Domain.sending_type`, `Message.template_id`, `CampaignIssueCode.text_unchecked`) are about templates, domains, messages and campaigns, which the plugin does not use.

## 1.0.0

### Major Changes

- d5cd182: First stable release. The plugin runs in production and its API is unchanged; from now on breaking changes are major releases. The source moved to `numoteq/js-packages`.

## 0.1.0

### Minor Changes

- d2a7cc8: Add the AhaSend email transport plugin.
