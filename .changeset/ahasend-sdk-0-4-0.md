---
"@numoteq/emdash-plugin-ahasend": patch
---

Update the bundled AhaSend SDK from 0.3.0 to 0.4.0. The SDK release is additive for the calls this plugin makes (`messages.send` and `messages.sendConversation`), and the breaking type changes it ships (`TemplateVariable.kind`, `Domain.sending_type`, `Message.template_id`, `CampaignIssueCode.text_unchecked`) are about templates, domains, messages and campaigns, which the plugin does not use.
