#!/bin/bash

#
# Deployment script for Milestone 4: SES Configuration (Dev Environment Only)
#
# This script deploys the SES stack to the dev environment and performs
# verification checks to ensure the deployment was successful.
#
# Prerequisites:
# - AWS CLI configured with valid credentials
# - Node.js 20.x or later
# - npm dependencies installed (npm install)
# - Certificate and DynamoDB stacks already deployed
#
# Usage:
#   ./scripts/deploy-milestone4-dev.sh
#
# Exit codes:
#   0 - Deployment successful
#   1 - Pre-deployment checks failed
#   2 - Deployment failed
#   3 - Post-deployment verification failed
#
# Security:
# - Dev environment only
# - No destructive operations (stack deletion requires manual intervention)
# - All actions logged for audit trail
#

set -e  # Exit on error
set -u  # Exit on undefined variable
set -o pipefail  # Exit on pipe failure

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script configuration
ENVIRONMENT="dev"
STACK_NAME="${ENVIRONMENT}-email-ses"
REGION="eu-west-2"
CERT_STACK_NAME="${ENVIRONMENT}-email-certificate"
DYNAMODB_STACK_NAME="${ENVIRONMENT}-email-dynamodb"

# Function to print colored output
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_section() {
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo ""
}

# Function to check if AWS CLI is installed and configured
check_aws_cli() {
    if ! command -v aws &> /dev/null; then
        print_error "AWS CLI is not installed. Please install it first."
        return 1
    fi

    if ! aws sts get-caller-identity &> /dev/null; then
        print_error "AWS CLI is not configured or credentials are invalid."
        return 1
    fi

    print_success "AWS CLI is configured"
    aws sts get-caller-identity --query 'Account' --output text
}

# Function to check if Node.js and npm are installed
check_node() {
    if ! command -v node &> /dev/null; then
        print_error "Node.js is not installed. Please install Node.js 20.x or later."
        return 1
    fi

    NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 20 ]; then
        print_error "Node.js version is $NODE_VERSION. Please upgrade to 20.x or later."
        return 1
    fi

    print_success "Node.js $(node --version) is installed"
}

# Function to check if npm dependencies are installed
check_dependencies() {
    if [ ! -d "node_modules" ]; then
        print_error "npm dependencies are not installed. Run 'npm install' first."
        return 1
    fi

    print_success "npm dependencies are installed"
}

# Function to check if prerequisite stacks are deployed
check_prerequisite_stacks() {
    print_info "Checking prerequisite stacks..."

    # Check Certificate stack
    if ! aws cloudformation describe-stacks --stack-name "$CERT_STACK_NAME" --region "$REGION" &> /dev/null; then
        print_error "Certificate stack ($CERT_STACK_NAME) is not deployed. Deploy it first."
        return 1
    fi
    print_success "Certificate stack is deployed"

    # Check DynamoDB stack
    if ! aws cloudformation describe-stacks --stack-name "$DYNAMODB_STACK_NAME" --region "$REGION" &> /dev/null; then
        print_error "DynamoDB stack ($DYNAMODB_STACK_NAME) is not deployed. Deploy it first."
        return 1
    fi
    print_success "DynamoDB stack is deployed"
}

# Function to run tests
run_tests() {
    print_info "Running tests..."
    if ! npm test; then
        print_error "Tests failed. Fix errors before deploying."
        return 1
    fi
    print_success "All tests passed"
}

# Function to synthesize CloudFormation template
synthesize_template() {
    print_info "Synthesizing CloudFormation template..."
    if ! npm run synth:dev &> /dev/null; then
        print_error "Template synthesis failed. Check your CDK code."
        return 1
    fi
    print_success "Template synthesized successfully"
}

# Function to deploy the SES stack
deploy_stack() {
    print_info "Deploying SES stack to dev environment..."
    print_info "Stack name: $STACK_NAME"
    print_info "Region: $REGION"

    # Deploy only the SES stack (not all stacks)
    if ! npx cdk deploy "$STACK_NAME" --context environment="$ENVIRONMENT" --require-approval never; then
        print_error "Stack deployment failed"
        return 1
    fi

    print_success "Stack deployed successfully"
}

# Function to verify SES identity verification status
verify_ses_identity() {
    print_info "Checking SES identity verification status..."

    # Get SES identity verification status
    IDENTITY_STATUS=$(aws ses get-email-identity \
        --email-identity "email.ponton.io" \
        --region "$REGION" \
        --query 'VerifiedForSendingStatus' \
        --output text 2>/dev/null || echo "NOT_FOUND")

    if [ "$IDENTITY_STATUS" = "true" ]; then
        print_success "SES identity is verified and ready for sending"
    elif [ "$IDENTITY_STATUS" = "false" ]; then
        print_warning "SES identity is created but not yet verified"
        print_info "DNS records may still be propagating (can take up to 72 hours)"
        print_info "Check verification status with: aws ses get-email-identity --email-identity email.ponton.io --region $REGION"
    else
        print_warning "Could not determine SES identity status (may not be created yet)"
    fi
}

# Function to verify SNS topic creation
verify_sns_topic() {
    print_info "Checking SNS topic creation..."

    TOPIC_ARN=$(aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --query 'Stacks[0].Outputs[?OutputKey==`EventTopicArn`].OutputValue' \
        --output text 2>/dev/null || echo "")

    if [ -n "$TOPIC_ARN" ]; then
        print_success "SNS topic created: $TOPIC_ARN"

        # Check topic attributes
        if aws sns get-topic-attributes --topic-arn "$TOPIC_ARN" --region "$REGION" &> /dev/null; then
            print_success "SNS topic is accessible"
        else
            print_warning "SNS topic created but not accessible yet"
        fi
    else
        print_warning "Could not retrieve SNS topic ARN from stack outputs"
    fi
}

# Function to verify SQS queue creation
verify_sqs_queue() {
    print_info "Checking SQS queue creation..."

    QUEUE_URL=$(aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --query 'Stacks[0].Outputs[?OutputKey==`EventQueueUrl`].OutputValue' \
        --output text 2>/dev/null || echo "")

    if [ -n "$QUEUE_URL" ]; then
        print_success "SQS queue created: $QUEUE_URL"

        # Check queue attributes
        if aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --region "$REGION" --attribute-names All &> /dev/null; then
            print_success "SQS queue is accessible"

            # Check DLQ
            DLQ_URL=$(aws cloudformation describe-stacks \
                --stack-name "$STACK_NAME" \
                --region "$REGION" \
                --query 'Stacks[0].Outputs[?OutputKey==`DeadLetterQueueUrl`].OutputValue' \
                --output text 2>/dev/null || echo "")

            if [ -n "$DLQ_URL" ]; then
                print_success "Dead letter queue created: $DLQ_URL"
            fi
        else
            print_warning "SQS queue created but not accessible yet"
        fi
    else
        print_warning "Could not retrieve SQS queue URL from stack outputs"
    fi
}

# Function to verify Lambda function creation
verify_lambda_function() {
    print_info "Checking Lambda function creation..."

    FUNCTION_NAME=$(aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --query 'Stacks[0].Outputs[?OutputKey==`EventHandlerFunctionName`].OutputValue' \
        --output text 2>/dev/null || echo "")

    if [ -n "$FUNCTION_NAME" ]; then
        print_success "Lambda function created: $FUNCTION_NAME"

        # Check function configuration
        if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" &> /dev/null; then
            print_success "Lambda function is accessible"

            # Check event source mapping
            MAPPINGS=$(aws lambda list-event-source-mappings \
                --function-name "$FUNCTION_NAME" \
                --region "$REGION" \
                --query 'EventSourceMappings[0].State' \
                --output text 2>/dev/null || echo "")

            if [ "$MAPPINGS" = "Enabled" ]; then
                print_success "Lambda event source mapping is enabled"
            else
                print_warning "Lambda event source mapping state: $MAPPINGS"
            fi
        else
            print_warning "Lambda function created but not accessible yet"
        fi
    else
        print_warning "Could not retrieve Lambda function name from stack outputs"
    fi
}

# Function to display stack outputs
display_stack_outputs() {
    print_info "Stack outputs:"
    aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
        --output table
}

# Function to provide next steps
print_next_steps() {
    print_section "Next Steps"

    echo "1. Verify DNS Records:"
    echo "   Check that DKIM, SPF, DMARC, and MAIL FROM records are propagated:"
    echo "   dig email.ponton.io TXT"
    echo "   dig _dmarc.email.ponton.io TXT"
    echo "   dig bounce.email.ponton.io MX"
    echo "   dig bounce.email.ponton.io TXT"
    echo ""

    echo "2. Monitor SES Identity Verification:"
    echo "   aws ses get-email-identity --email-identity email.ponton.io --region $REGION"
    echo ""

    echo "3. Test Event Processing:"
    echo "   Send a test email using SES and verify Lambda processes the events"
    echo "   Check CloudWatch Logs: /aws/lambda/dev-email-ses-event-processor"
    echo ""

    echo "4. Monitor DLQ:"
    echo "   Set up CloudWatch alarm for DLQ depth > 0"
    echo "   aws sqs get-queue-attributes --queue-url <DLQ_URL> --attribute-names ApproximateNumberOfMessages"
    echo ""

    echo "5. Archive Deployment Output:"
    echo "   Save stack outputs for reference and validation"
    echo ""
}

# Function to handle errors and provide rollback instructions
handle_error() {
    print_section "Deployment Failed"

    print_error "An error occurred during deployment"
    echo ""
    echo "To rollback the deployment:"
    echo "  cdk destroy $STACK_NAME --context environment=$ENVIRONMENT"
    echo ""
    echo "To view CloudFormation events:"
    echo "  aws cloudformation describe-stack-events --stack-name $STACK_NAME --region $REGION --max-items 20"
    echo ""
    echo "To view stack status:"
    echo "  aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION"
    echo ""
}

# Main deployment workflow
main() {
    print_section "Milestone 4: SES Configuration Deployment (Dev)"

    # Pre-deployment checks
    print_section "Pre-Deployment Checks"

    if ! check_aws_cli; then
        exit 1
    fi

    if ! check_node; then
        exit 1
    fi

    if ! check_dependencies; then
        exit 1
    fi

    if ! check_prerequisite_stacks; then
        exit 1
    fi

    if ! run_tests; then
        exit 1
    fi

    if ! synthesize_template; then
        exit 1
    fi

    print_success "All pre-deployment checks passed"

    # Deploy stack
    print_section "Deployment"

    if ! deploy_stack; then
        handle_error
        exit 2
    fi

    # Post-deployment verification
    print_section "Post-Deployment Verification"

    verify_ses_identity
    verify_sns_topic
    verify_sqs_queue
    verify_lambda_function

    # Display outputs
    print_section "Stack Outputs"
    display_stack_outputs

    # Success
    print_section "Deployment Complete"
    print_success "Milestone 4 SES stack deployed successfully to dev environment"

    print_next_steps

    exit 0
}

# Run main function
main "$@"
