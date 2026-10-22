import type { ProviderInfo } from '../../../ports/chat-provider';
import { anthropicMessagesErrors } from '../../protocols/anthropic-messages/error';

export const anthropicInfo: ProviderInfo = {
  id: 'anthropic',
  the: 'a Anthropic',
  of: 'da Anthropic',
  to: 'à Anthropic',
  keyPlaceholder: 'sk-ant-…',
  keysUrl: 'https://console.anthropic.com/settings/keys',
  defaultFamilies: ['sonnet', 'haiku'],
  titleFamily: 'haiku',
};

export const anthropicErrors = anthropicMessagesErrors(anthropicInfo);
