import { Button, Flex, Heading, Image, SelectField, Text, View } from '@aws-amplify/ui-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getConfig } from '../config';
import { changeLanguage, type PortalLanguage } from '../i18n';

/**
 * Branded header (R1.7): logo, name and colour come from `config.json` (`brand`), never from code.
 * Also hosts the language toggle (R3.6) and the sign-out button.
 */
export interface BrandProps {
  email?: string;
  onSignOut?: () => void;
  compact?: boolean;
}

export function Brand({ email, onSignOut, compact = false }: BrandProps) {
  const { t, i18n } = useTranslation();
  const { brand } = getConfig();
  const lang = (i18n.language?.startsWith('ko') ? 'ko' : 'en') as PortalLanguage;
  // A logo URL that does not resolve (dev 2026-10-01: nothing deployed at /brand/logo.svg) rendered the broken-image
  // glyph plus the alt text next to the heading that already shows the name; drop the image instead.
  const [logoFailed, setLogoFailed] = useState(false);

  return (
    <Flex
      as="header"
      direction="row"
      alignItems="center"
      justifyContent="space-between"
      padding="0.75rem 1rem"
      style={{ borderBottom: `3px solid ${brand.primaryColor}` }}
    >
      <Flex direction="row" alignItems="center" gap="0.75rem">
        {brand.logoUrl && !logoFailed ? (
          <Image
            src={brand.logoUrl}
            alt=""
            height={compact ? '32px' : '40px'}
            objectFit="contain"
            onError={() => setLogoFailed(true)}
            data-testid="brand-logo"
          />
        ) : null}
        <Heading level={compact ? 4 : 3} margin="0">
          {brand.name}
        </Heading>
      </Flex>
      <Flex direction="row" alignItems="center" gap="0.75rem">
        {email ? (
          <Text fontSize="small" color="font.tertiary">
            {t('app.signedInAs', { email })}
          </Text>
        ) : null}
        <SelectField
          label={t('app.language')}
          labelHidden
          size="small"
          value={lang}
          onChange={(e) => void changeLanguage(e.target.value as PortalLanguage)}
        >
          <option value="ko">{t('app.languageKo')}</option>
          <option value="en">{t('app.languageEn')}</option>
        </SelectField>
        {onSignOut ? (
          <Button size="small" variation="link" onClick={onSignOut}>
            {t('app.signOut')}
          </Button>
        ) : null}
      </Flex>
    </Flex>
  );
}

export function BrandFooter() {
  const { brand } = getConfig();
  return (
    <View as="footer" padding="1rem" textAlign="center">
      <Text fontSize="small" color="font.tertiary">
        {brand.name}
      </Text>
    </View>
  );
}
