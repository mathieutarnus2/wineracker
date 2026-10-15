#!/usr/bin/env bash
# À lancer une seule fois dans Cloud Shell : autorise GitHub (dépôt mathieutarnus2/wineracker) à publier le site, sans clé.
set -e
P=wineracker-2e52e; DEPOT=mathieutarnus2/wineracker; SA=github-deploy@$P.iam.gserviceaccount.com
NUM=$(gcloud projects describe $P --format='value(projectNumber)')
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project $P
gcloud iam service-accounts describe $SA --project $P >/dev/null 2>&1 || gcloud iam service-accounts create github-deploy --display-name "Publication depuis GitHub" --project $P
for R in roles/firebasehosting.admin roles/firebase.viewer roles/serviceusage.serviceUsageConsumer roles/cloudfunctions.admin roles/run.admin roles/artifactregistry.admin roles/cloudbuild.builds.editor roles/secretmanager.viewer roles/firebaseextensions.viewer roles/firebaserules.admin roles/datastore.indexAdmin roles/cloudscheduler.viewer roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding $P --member "serviceAccount:$SA" --role $R --condition=None -q >/dev/null
done
# le serveur se publie en agissant comme le compte de service des fonctions
gcloud iam service-accounts add-iam-policy-binding $NUM-compute@developer.gserviceaccount.com --project $P --role roles/iam.serviceAccountUser --member "serviceAccount:$SA" -q >/dev/null
gcloud iam workload-identity-pools describe github --location global --project $P >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create github --location global --display-name "GitHub" --project $P
gcloud iam workload-identity-pools providers describe github --location global --workload-identity-pool github --project $P >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools providers create-oidc github --location global --workload-identity-pool github \
    --issuer-uri https://token.actions.githubusercontent.com \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition "assertion.repository=='$DEPOT'" --project $P
gcloud iam service-accounts add-iam-policy-binding $SA --project $P --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$NUM/locations/global/workloadIdentityPools/github/attribute.repository/$DEPOT" -q >/dev/null
npx --yes firebase-tools@15 hosting:sites:get wineracker-staging --project $P >/dev/null 2>&1 || npx --yes firebase-tools@15 hosting:sites:create wineracker-staging --project $P
echo "C'est prêt : GitHub peut publier le site."
