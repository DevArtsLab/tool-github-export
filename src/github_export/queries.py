"""GraphQL queries for the GitHub v4 API."""

# One query per owner (user or org) via the repositoryOwner interface.
# Paginated on repositories(first: 100).
REPOSITORIES_QUERY = """
query ($login: String!, $cursor: String) {
  repositoryOwner(login: $login) {
    login
    __typename
    repositories(
      first: 100
      after: $cursor
      affiliations: [OWNER]
      orderBy: { field: PUSHED_AT, direction: DESC }
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        name
        nameWithOwner
        description
        url
        homepageUrl
        visibility
        isPrivate
        isFork
        isArchived
        isTemplate
        isDisabled
        isLocked
        stargazerCount
        forkCount
        diskUsage
        createdAt
        updatedAt
        pushedAt
        openGraphImageUrl
        usesCustomOpenGraphImage
        owner {
          login
          __typename
        }
        defaultBranchRef {
          name
        }
        primaryLanguage {
          name
          color
        }
        licenseInfo {
          spdxId
          name
        }
        parent {
          nameWithOwner
        }
        watchers {
          totalCount
        }
        issues(states: OPEN) {
          totalCount
        }
        repositoryTopics(first: 20) {
          nodes {
            topic {
              name
            }
          }
        }
        languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
          totalSize
          edges {
            size
            node {
              name
              color
            }
          }
        }
        latestRelease {
          tagName
          publishedAt
        }
      }
    }
  }
  rateLimit {
    cost
    remaining
  }
}
"""
