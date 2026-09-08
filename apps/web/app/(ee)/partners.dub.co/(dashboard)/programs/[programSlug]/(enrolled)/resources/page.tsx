"use client";

import useProgramResources from "@/lib/swr/use-program-resources";
import { PageContent } from "@/ui/layout/page-content";
import { PageWidthWrapper } from "@/ui/layout/page-width-wrapper";
import { ResourceCard } from "@/ui/partners/resources/resource-card";
import { ResourceSection } from "@/ui/partners/resources/resource-section";
import { AnimatedEmptyState } from "@/ui/shared/animated-empty-state";
import { BlurImage, useTranslations } from "@dub/ui";
import { FileContent, FileZip2, Link4, Palette2, Post } from "@dub/ui/icons";
import {
  formatFileSize,
  getApexDomain,
  getFileExtension,
  getPrettyUrl,
  GOOGLE_FAVICON_URL,
} from "@dub/utils";

const emptyStateIcons = [Post, Palette2, FileZip2, Link4];

export default function PartnerProgramResourcesPage() {
  const t = useTranslations("partner");
  const { resources, isLoading, isValidating } = useProgramResources();

  const isEmpty =
    !isLoading &&
    ["logos", "colors", "files", "links"].every(
      (resource) => !resources?.[resource]?.length,
    );

  return (
    <PageContent title={t("navigation.resources") || "Resources"}>
      <PageWidthWrapper className="pb-10">
        {isLoading || !isEmpty ? (
          <div className="flex flex-col gap-10">
            {(isLoading || !!resources?.logos?.length) && (
              <ResourceSection
                resource="logo"
                title="Brand logos"
                isLoading={isLoading}
                isValidating={isValidating}
              >
                {resources?.logos?.map((logo) => (
                  <ResourceCard
                    key={logo.id}
                    resourceType="logo"
                    icon={
                      <div className="relative size-8 overflow-hidden">
                        <BlurImage
                          src={logo.url}
                          alt="thumbnail"
                          className="size-full object-contain"
                        />
                      </div>
                    }
                    title={logo.name || "Logo"}
                    description={`${getFileExtension(logo.url) || "Unknown"}・${formatFileSize(logo.size, 0)}`}
                    downloadUrl={logo.url}
                  />
                ))}
              </ResourceSection>
            )}

            {(isLoading || !!resources?.links?.length) && (
              <ResourceSection
                resource="link"
                title="Brand links"
                isLoading={isLoading}
                isValidating={isValidating}
              >
                {resources?.links?.map((link) => (
                  <ResourceCard
                    key={link.id}
                    resourceType="link"
                    icon={
                      <div className="flex size-full items-center justify-center bg-neutral-50">
                        <BlurImage
                          src={`${GOOGLE_FAVICON_URL}${getApexDomain(link.url)}`}
                          alt="favicon"
                          className="size-4"
                        />
                      </div>
                    }
                    title={link.name || "Link"}
                    description={getPrettyUrl(link.url)}
                    visitUrl={link.url}
                  />
                ))}
              </ResourceSection>
            )}

            {(isLoading || !!resources?.colors?.length) && (
              <ResourceSection
                resource="color"
                title="Brand colors"
                isLoading={isLoading}
                isValidating={isValidating}
              >
                {resources?.colors?.map((color) => (
                  <ResourceCard
                    key={color.id}
                    resourceType="color"
                    icon={
                      <div
                        className="size-full border border-black/10"
                        style={{ backgroundColor: color.color }}
                      />
                    }
                    title={color.name || "Color"}
                    description={color.color.toUpperCase()}
                    copyText={color.color}
                  />
                ))}
              </ResourceSection>
            )}

            {(isLoading || !!resources?.files?.length) && (
              <ResourceSection
                resource="file"
                title="Brand files"
                isLoading={isLoading}
                isValidating={isValidating}
              >
                {resources?.files?.map((file) => (
                  <ResourceCard
                    key={file.id}
                    resourceType="file"
                    icon={
                      <div className="flex size-full items-center justify-center bg-neutral-50">
                        <FileContent className="size-4 text-neutral-800" />
                      </div>
                    }
                    title={file.name || "File"}
                    description={`${getFileExtension(file.url) || "Unknown"}・${formatFileSize(file.size, 0)}`}
                    downloadUrl={file.url}
                  />
                ))}
              </ResourceSection>
            )}
          </div>
        ) : (
          <AnimatedEmptyState
            title={t("resources.title") || "Resources"}
            description={
              t("resources.noResourcesDescription") ||
              "When this program adds resources, they'll appear here."
            }
            cardContent={(idx) => {
              const Icon = emptyStateIcons[idx % emptyStateIcons.length];
              return (
                <>
                  <Icon className="size-4 text-neutral-700" />
                  <div className="h-2.5 w-24 min-w-0 rounded-sm bg-neutral-200" />
                </>
              );
            }}
          />
        )}
      </PageWidthWrapper>
    </PageContent>
  );
}
